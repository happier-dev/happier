import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

const isPublication = resource => resource !== null && typeof resource === 'object'
  && (resource.kind === undefined || resource.kind === 'workspace');
const scopeIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const isResource = resource => resource !== null && typeof resource === 'object'
  && typeof resource.path === 'string' && resource.path.trim().length > 0
  && [undefined, 'workspace', 'dependency', 'dependency-input-writer'].includes(resource.kind)
  && (isPublication(resource) || (typeof resource.installDir === 'string' && resource.installDir.trim().length > 0));
const indexPrefix = lockPath => `${basename(lockPath)}.priority-waiter-`;
const indexPath = (lockPath, id) => `${lockPath}.priority-waiter-${id}`;
const anchorPath = (lockPath, id) => `${lockPath}.priority-scope-${id}`;
const compare = (left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id);

/** Private projection of the bundle-lock owner's priority lifecycle. The owner
 * supplies all authentication, liveness, protection and quarantine recovery;
 * this module decides only preference among its currently active scopes. */
export function createWorkspaceBundleLockPriorityOwner(policy) {
  const scopes = new WeakMap();

  function publish(path, raw, options) {
    mkdirSync(dirname(path), { recursive: true });
    const staged = `${path}.stage-${randomUUID()}`;
    let fd;
    let opened = false;
    try {
      fd = openSync(staged, 'wx', 0o600);
      opened = true;
      policy.protect(staged, fd, options);
      writeFileSync(fd, raw, 'utf8');
      try { closeSync(fd); } finally { fd = undefined; }
      // All bytes and permissions precede visibility, including on Windows.
      if (policy.read(path).exists) throw new Error(`Workspace priority publication is already present: ${path}`);
      renameSync(staged, path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (opened) {
        try { unlinkSync(staged); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }

  function readAnchor(path, options) {
    if (!policy.read(path).exists) policy.recover(path, options);
    const snapshot = policy.read(path);
    if (snapshot.exists && policy.reclaimable(snapshot, options)) {
      const removed = policy.remove(path, snapshot.raw);
      const current = policy.read(path);
      if (!removed && current.exists && (!current.readable || current.raw === snapshot.raw)) {
        throw new Error(`Workspace priority cleanup is pending: ${path}`);
      }
      return current;
    }
    return snapshot;
  }

  function inspect(lockPath, options = {}) {
    const prefix = indexPrefix(lockPath);
    const excludedId = scopes.get(options.priorityScope)?.id;
    let names;
    try { names = readdirSync(dirname(lockPath)); }
    catch (error) { if (error.code === 'ENOENT') return { active: [], ignored: [] }; throw error; }
    const active = [];
    const ignored = [];
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const id = name.slice(prefix.length);
      if (!scopeIdPattern.test(id) || id === excludedId) continue;
      const path = join(dirname(lockPath), name);
      const index = policy.read(path);
      if (!index.exists) continue;
      const firstPath = index.owner?.priorityAnchorLockPath;
      if (index.owner?.priorityScopeId !== id || typeof firstPath !== 'string' || !isAbsolute(firstPath)) {
        if (policy.reclaimable(index, options) && policy.remove(path, index.raw)) continue;
        ignored.push([id, 'ignored', 'invalid-index']);
        continue;
      }
      const anchor = readAnchor(anchorPath(firstPath, id), options);
      if (!anchor.exists) {
        // An index is published before activation. Never retire a live pending
        // index while its producer is still committing the whole scope.
        if (policy.reclaimable(index, options)) policy.remove(path, index.raw);
        continue;
      }
      const resources = anchor.owner?.priorityResources;
      if (anchor.owner?.priorityScopeId !== id || !Array.isArray(resources) || !resources.every(isResource)
        || !resources.every(resource => isAbsolute(resource.path))
        || !Number.isFinite(anchor.owner?.createdAtMs) || anchor.owner.createdAtMs <= 0
        || !resources.some(resource => isPublication(resource) && resource.path === firstPath)
        || !policy.sameOwner(index, anchor, anchorPath(firstPath, id))) {
        // Soft preference grants neither exclusion nor custody. Invalid live
        // participants get no preference, but only canonical liveness/reclaim
        // may retire their bytes; actual leases and legacy claims stay strict.
        ignored.push([id, 'ignored', 'invalid-owner-or-declaration']);
        continue;
      }
      active.push({ id, createdAtMs: Number(anchor.owner.createdAtMs), resources, snapshot: anchor });
    }
    return { active: active.sort(compare), ignored: ignored.sort((left, right) => left[0].localeCompare(right[0])) };
  }

  const observationSnapshot = ({ active, ignored }) => JSON.stringify([
    ...active.map(({ id, createdAtMs, resources }) => [id, createdAtMs, resources]), ...ignored,
  ]);

  function create({ resources, env = process.env, signal, isHeldResourceContinuation, ...options }) {
    if (!Array.isArray(resources)) throw new Error('Workspace priority requires declared resources');
    const declared = resources.map(resource => {
      if (!isResource(resource)) {
        throw new Error('Workspace priority requires canonical workspace resources');
      }
      return { path: resolve(resource.path), ...(resource.kind ? { kind: resource.kind } : {}),
        ...(!isPublication(resource) ? { installDir: resource.installDir } : {}) };
    });
    const paths = [...new Set(declared.filter(isPublication).map(resource => resource.path))].sort();
    const id = randomUUID();
    const createdAtMs = Date.now();
    const ownerOptions = { ...options, env };
    const owner = policy.owner({ id, createdAtMs }, ownerOptions);
    if (paths.length && (!Number.isFinite(owner?.createdAtMs) || owner.createdAtMs <= 0
      || !policy.sameOwner({ owner }, { owner }, anchorPath(paths[0], id)))) {
      throw new Error('Workspace publication priority owner initialization failed');
    }
    const state = { id, createdAtMs, paths, resources: declared, env, signal,
      isHeldResourceContinuation, ownerOptions, active: false, disposed: false,
      anchor: paths.length ? anchorPath(paths[0], id) : null, anchorRaw: null, indexes: [] };
    function stillOwned(path, raw) {
      // A lost delete may leave a successor. Authentication and retained-file
      // cleanup remain with the supplied canonical lock policy.
      const current = policy.read(path);
      return current.exists && (!current.readable || current.raw === raw
        || policy.sameOwner(current, { owner }, state.anchor));
    }
    const scope = {
      activate() {
        signal?.throwIfAborted();
        if (state.disposed) throw new Error('Workspace priority scope is already disposed');
        if (state.active || paths.length === 0) return;
        try {
          for (const path of paths) {
            const target = indexPath(path, id);
            const raw = JSON.stringify({ ...owner, priorityScopeId: id, priorityAnchorLockPath: paths[0] });
            state.indexes.push({ path: target, raw });
            publish(target, raw, ownerOptions);
          }
          const raw = JSON.stringify({ ...owner, priorityScopeId: id, priorityResources: declared });
          state.anchorRaw = raw;
          publish(state.anchor, raw, ownerOptions);
          state.active = true;
          // One anchor is the whole-group commit. Wake each resource's existing
          // directory watch only after every index can observe that commit.
          const now = new Date();
          for (const index of state.indexes) utimesSync(index.path, now, now);
        } catch (error) {
          scope.suspend();
          throw error;
        }
      },
      suspend() {
        if (state.anchorRaw === null && state.indexes.length === 0) return;
        // Withdraw the common authority before removing any resource index;
        // readers cannot elect opposite priorities from partial registration.
        if (state.anchor && !policy.clear(state.anchor, state.anchorRaw, owner, ownerOptions)
          && stillOwned(state.anchor, state.anchorRaw)) {
          throw new Error(`Workspace priority cleanup is pending: ${state.anchor}`);
        }
        state.anchorRaw = null;
        state.active = false;
        for (const index of state.indexes) {
          if (!policy.remove(index.path, index.raw) && stillOwned(index.path, index.raw)) {
            throw new Error(`Workspace priority cleanup is pending: ${index.path}`);
          }
        }
        state.indexes = [];
      },
      dispose() {
        scope.suspend();
        state.disposed = true;
      },
    };
    scopes.set(scope, state);
    return scope;
  }

  return {
    create,
    isRelevant(lockPath, filename, scope) {
      const name = String(filename);
      return [indexPrefix(lockPath), `${basename(lockPath)}.priority-scope-`]
        .some(prefix => name.startsWith(prefix) && scopeIdPattern.test(name.slice(prefix.length))
          && name.slice(prefix.length) !== scopes.get(scope)?.id);
    },
    snapshot(lockPath, options) {
      return observationSnapshot(inspect(lockPath, options));
    },
    observation(lockPath, scope, options) {
      const state = scopes.get(scope);
      if (!state) throw new Error('Workspace priority requires an owner-created scope');
      if (state.active && !policy.read(indexPath(lockPath, state.id)).exists) {
        throw new Error(`Workspace publication is outside its declared priority scope: ${lockPath}`);
      }
      const observed = inspect(lockPath, { ...options, priorityScope: scope });
      return {
        predecessor: observed.active.find(candidate => candidate.id !== state.id && compare(candidate, state) < 0) ?? null,
        snapshot: observationSnapshot(observed),
      };
    },
    canContinue(scope, predecessor, options) {
      const state = scopes.get(scope);
      return predecessor.resources.some(resource => isPublication(resource)
        ? policy.holdsPublication(resource.path, options)
        : state.isHeldResourceContinuation?.(resource, options.env ?? state.env) === true);
    },
  };
}
