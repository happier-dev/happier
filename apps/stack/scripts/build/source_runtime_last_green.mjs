import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** The last green is the newest completed producer run: completed capture
 * locators carry producer success, and each reload's own readiness checks prove
 * the load before activation (the load sentinel that once gated this was retired
 * by the 11-17 owner ruling). Old current locators also prove publication, while
 * old capture-only locators do not prove a whole run passed. */
export async function readGreenSourceRuntimeCandidateGroups({ bundleRoot }) {
  let names;
  try { names = await readdir(bundleRoot); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const groups = new Map();
  for (const name of names) {
    if (!/^candidate-(?:(?:capture-)?[a-f0-9]{64}|capture-(?:bundle|runtime|web)-[^\\/\0]+)\.json$/.test(name)) continue;
    const candidate = await optionalJson(join(bundleRoot, name));
    if (!/^(?:bundle|runtime|web)-[^\\/\0]+$/.test(candidate?.outputName ?? '')
        || !/^[a-f0-9]{64}$/.test(candidate?.reuseFingerprint ?? '')) continue;
    const currentKey = /^candidate-([a-f0-9]{64})\.json$/.exec(name)?.[1];
    const key = candidate.producerCandidateKey ?? currentKey;
    if (!key || (!candidate.producerCompletedAt && !currentKey && !candidate.producerCandidateKey)) continue;
    const record = await optionalJson(join(bundleRoot, candidate.outputName, 'source-bundle.json'));
    if (!record || record.inputIdentity !== candidate.inputIdentity || record.reuseFingerprint !== candidate.reuseFingerprint) continue;
    let completedAt = Date.parse(candidate.producerCompletedAt);
    if (!Number.isFinite(completedAt)) {
      // The legacy current pointer was written only after the whole producer
      // succeeded. Its timestamp is evidence; capture time alone is not.
      try { completedAt = (await stat(join(bundleRoot, name))).mtimeMs; }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    }
    const capturedAt = Date.parse(record.sourceCapture?.capturedAt);
    if (!Number.isFinite(capturedAt)) continue;
    const groupKey = candidate.producerCompletedAt ?? `legacy-${record.sourceCapture.capturedAt}`;
    const group = groups.get(groupKey) ?? { candidates: new Map(), completedAt: 0, capturedAt: 0 };
    group.completedAt = Math.max(group.completedAt, completedAt);
    group.capturedAt = Math.max(group.capturedAt, capturedAt);
    group.candidates.set(key, candidate);
    groups.set(groupKey, group);
  }
  return [...groups.values()]
    .sort((left, right) => right.capturedAt - left.capturedAt || right.completedAt - left.completedAt);
}


export function sourceRuntimeCaptureUnavailable({
  message = 'No retained producer capture has completed',
  nextAction = 'Request a fresh capture with --source-after or a committed revision with --rev',
} = {}) {
  return Object.assign(new Error(message), {
    code: 'source_runtime_producer_capture_unavailable', retryable: false, nextAction,
  });
}
