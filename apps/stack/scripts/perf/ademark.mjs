import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { percentile } from './analysis.mjs';

const clocksByMetric = {
  'A1-web-cold': ['navigationStartMs', 'firstSessionRowPaintMs'],
  'A4-first-request': ['startTapMs', 'firstProviderRequestMs'],
};

export async function replayAdemarkSamples(args) {
  const { values } = parseArgs({ args, options: {
    bed: { type: 'string' },
    host: { type: 'string' },
    n: { type: 'string' },
    samples: { type: 'string' },
  } });
  const { bed, host, samples: samplesPath } = values;
  const n = Number(values.n);
  if (!bed || !host || !samplesPath || !/^[1-9]\d*$/u.test(values.n ?? '') || !Number.isSafeInteger(n)) {
    throw new Error('Usage: perf.mjs ademark --bed NAME --host HOST --n COUNT --samples PATH');
  }

  let input;
  const contents = await readFile(samplesPath, 'utf8');
  try {
    input = JSON.parse(contents);
  } catch {
    throw new Error('ADEMark samples must be a JSON object');
  }
  if (input?.bed !== bed || input.host !== host) {
    throw new Error('ADEMark samples must match the selected bed and host');
  }
  const { rev, at, metric, samples } = input;
  if (typeof rev !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(rev)
      || typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) {
    throw new Error('ADEMark samples require a full revision and a UTC ISO capture timestamp');
  }
  if (typeof metric !== 'string' || !Object.hasOwn(clocksByMetric, metric)) {
    throw new Error('Unknown ADEMark timing metric');
  }
  if (!Array.isArray(samples) || samples.length !== n) {
    throw new Error('ADEMark sample count does not match --n');
  }
  const [start, end] = clocksByMetric[metric];
  const durations = samples.map((sample, index) => {
    const startMs = sample?.[start];
    const endMs = sample?.[end];
    const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : NaN;
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new Error('ADEMark sample ' + (index + 1) + ' requires finite, ordered ' + start + ' and ' + end);
    }
    return durationMs;
  });
  return { metric, unit: 'ms', n, p50: percentile(durations, .5), p90: percentile(durations, .9), host, rev, at };
}
