import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CHROMIUM_FOR_TESTING_PRODUCT_SOURCE, resolveChromiumForTestingAssetVersion,
  resolveChromiumForTestingPlatform, type BrowserExtensionPermissionReviewV1,
  type BrowserExtensionRecordV1 } from '@happier-dev/protocol';
import type { BrowserExtensionActionIdV1, BrowserExtensionActionInputV1, BrowserExtensionActionResultV1,
  BrowserProfileExtensionV1 } from '@happier-dev/protocol/actions';
import type { BrowserProfileStore } from '../profiles/store';
import type { BrowserSidecarExtensionSurface } from '../sidecar/controlAdapter';
import { acquireBrowserExtension } from './acquisition';
import { browserCommandScope } from '../control/types';

export type BrowserExtensionService = Readonly<{
  execute(actionId: BrowserExtensionActionIdV1, input: BrowserExtensionActionInputV1,
    context?: Parameters<typeof browserCommandScope>[0]): Promise<BrowserExtensionActionResultV1>;
}>;

/** The same pinned engine version used by managed installation selects compatible CWS packages. */
export function managedBrowserExtensionChromeVersion(): string {
  const platform = resolveChromiumForTestingPlatform(process.platform, process.arch);
  return platform ? resolveChromiumForTestingAssetVersion(CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.assetsByPlatform[platform])
    : CHROMIUM_FOR_TESTING_PRODUCT_SOURCE.pinnedVersion;
}

function sameGrants(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(left);
  return values.size === new Set(right).size && right.every(value => values.has(value));
}

function reviewMatches(review: BrowserExtensionPermissionReviewV1 | undefined, extension: BrowserExtensionRecordV1): boolean {
  return review?.version === extension.version && sameGrants(review.permissions, extension.permissions)
    && sameGrants(review.hostPermissions, extension.hostPermissions);
}

/** An admitted profile mutation uses native loading; permissions are reviewed before publication. */
export function createBrowserExtensionService(input: Readonly<{
  profileStore: BrowserProfileStore;
  runtime?: BrowserSidecarExtensionSurface;
}>): BrowserExtensionService {
  const store = input.profileStore;
  const unavailable = (code: Extract<BrowserExtensionActionResultV1, { status: 'unavailable' }>['code']) =>
    ({ status: 'unavailable' as const, code });
  const runtimeFor = (profileId: string) => input.runtime?.getProfileRuntime?.(profileId);
  const entryFor = (profileId: string, extension: BrowserExtensionRecordV1): BrowserProfileExtensionV1 => {
    const running = runtimeFor(profileId);
    return { profileId, extension, restartRequired: Boolean(running?.active
      && running.extensionDirectories.includes(extension.directory) !== extension.enabled) };
  };
  return {
    async execute(actionId, request, context) {
      const signal = context?.signal;
      let acquiredDirectory: string | undefined;
      try {
        signal?.throwIfAborted();
        if (actionId === 'browser.extensions.list') {
          const profile = request.profileId ? store.getProfile(request.profileId) ?? await store.loadPersistentProfile(request.profileId) : null;
          if (request.profileId && !profile) return unavailable('profile_not_found');
          const profiles = profile ? [profile] : await store.listPersistentProfiles();
          const entries: BrowserProfileExtensionV1[] = [];
          for (const selected of profiles) {
            const result = await store.listExtensions(selected.profileId);
            if (!result.ok) return unavailable(result.reason);
            entries.push(...result.extensions.map(extension => entryFor(selected.profileId, extension)));
          }
          return { status: 'ready', entries };
        }
        const profileId = request.profileId!;
        const profile = store.getProfile(profileId) ?? await store.loadPersistentProfile(profileId);
        if (!profile && actionId !== 'browser.extensions.install') return unavailable('profile_not_found');
        const current = profile ? await store.listExtensions(profileId) : { ok: true as const, extensions: [] };
        if (!current.ok) return unavailable(current.reason);
        const extensionId = 'extensionId' in request ? request.extensionId
          : 'source' in request && request.source.kind === 'webStore' ? request.source.extensionId : undefined;
        const existing = current.extensions.find(extension => extension.id === extensionId);
        if (actionId === 'browser.extensions.openActionPopup' || actionId === 'browser.extensions.openOptions') {
          if (!existing) return unavailable('extension_not_found');
          if (!existing.enabled) return unavailable('extension_disabled');
          const kind = actionId === 'browser.extensions.openActionPopup' ? 'actionPopup' : 'optionsPage';
          if (!existing[kind]) return unavailable(kind === 'actionPopup' ? 'missing_popup' : 'missing_options');
          if (!input.runtime || !('commandId' in request)) return unavailable('managed_browser_required');
          return await input.runtime.openView({ commandId: request.commandId, browserSessionId: request.browserSessionId,
            viewId: request.viewId, profileId, extension: existing, kind }, browserCommandScope(context));
        }
        if (actionId !== 'browser.extensions.install' && !existing) return unavailable('extension_not_found');
        let replacement: BrowserExtensionRecordV1 | undefined;
        let reviewedChange = false;
        if (actionId === 'browser.extensions.install' || actionId === 'browser.extensions.update') {
          const source = 'source' in request ? request.source : existing!.source;
          const acquired = await acquireBrowserExtension({ source,
            storageDirectory: join(store.resolveProfileDirectory(profileId), 'extensions', 'packages'),
            chromeVersion: managedBrowserExtensionChromeVersion(), signal,
            ...(existing ? { existingDirectory: existing.directory } : {}) });
          if (!acquired.ok) return unavailable(signal?.aborted ? 'canceled'
            : acquired.errorCode === 'extension_acquisition_failed' ? 'source_unavailable'
              : acquired.errorCode === 'extension_manifest_unsupported' ? 'unsupported_manifest' : 'invalid_manifest');
          acquiredDirectory = acquired.extension.directory;
          replacement = { ...acquired.extension, enabled: existing?.enabled ?? true,
            ...('provenance' in request && request.provenance ? { provenance: request.provenance }
              : existing?.provenance ? { provenance: existing.provenance } : {}) };
          if (existing && replacement.id !== existing.id) return unavailable('invalid_manifest');
          if ('expectedVersion' in request && request.expectedVersion !== undefined && replacement.version !== request.expectedVersion) {
            return unavailable('version_changed');
          }
          const addsGrants = !existing || replacement.permissions.some(value => !existing.permissions.includes(value))
            || replacement.hostPermissions.some(value => !existing.hostPermissions.includes(value));
          if (addsGrants && !reviewMatches('reviewedPermissions' in request ? request.reviewedPermissions : undefined, replacement)) {
            return { status: 'needs_review', review: { version: replacement.version,
              permissions: replacement.permissions, hostPermissions: replacement.hostPermissions },
              ...(runtimeFor(profileId)?.active ? { restartRequired: true as const } : {}) };
          }
          reviewedChange = addsGrants;
        } else if (existing && actionId !== 'browser.extensions.remove') {
          replacement = { ...existing, enabled: actionId === 'browser.extensions.enable' };
        }
        // This is the point of effect, after acquisition/review. The engine owner settles its own
        // views before a package is removed. No extra Action admission or policy decision occurs.
        const active = runtimeFor(profileId)?.active;
        if (active && !reviewedChange && !('restartConfirmed' in request && request.restartConfirmed)) {
          return { status: 'needs_restart_confirmation', profileId };
        }
        if (active) {
          if (!input.runtime?.restartProfile) return unavailable('restart_failed');
          try { await input.runtime.restartProfile(profileId); } catch { return unavailable('restart_failed'); }
        }
        signal?.throwIfAborted();
        if (!profile) await store.registerPersistentProfile({ profileId, storageMode: 'user',
          owner: { kind: 'user', id: profileId }, cleanupOnSessionClose: false });
        if (actionId === 'browser.extensions.remove') {
          const result = await store.removeExtension(profileId, existing!.id);
          if (!result.ok) return unavailable(result.reason);
          await rm(existing!.directory, { recursive: true, force: true });
          return { status: 'removed', profileId, extensionId: existing!.id, restartRequired: true };
        }
        const result = await store.setExtension(profileId, replacement!);
        if (!result.ok) return unavailable(result.reason);
        acquiredDirectory = undefined; // The profile record now owns this package and its purge.
        if (existing && existing.directory !== replacement!.directory) await rm(existing.directory, { recursive: true, force: true });
        return { status: 'updated', entry: entryFor(profileId, replacement!), restartRequired: true };
      } catch {
        return unavailable(signal?.aborted ? 'canceled' : 'profile_unavailable');
      } finally {
        if (acquiredDirectory) await rm(acquiredDirectory, { recursive: true, force: true });
      }
    },
  };
}
