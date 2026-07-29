import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const phrasesDir = join(fixtureRoot, 'phrases');
const ffmpegCommand = process.env.FFMPEG_PATH || 'ffmpeg';
const espeakCommand = process.env.ESPEAK_PATH || 'espeak';
const espeakSource = Object.freeze({
  version: '1.48.03',
  sourceUrl: 'https://downloads.sourceforge.net/project/espeak/espeak/espeak-1.48/espeak-1.48.04-source.zip',
  sourceArchiveSha256: 'bf9a17673adffcc28ff7ea18764f06136547e97bbd9edf2ec612f09b207f0659',
  engineLicense: 'GPL-3.0-or-later',
  outputLicenseEvidence: 'https://sourceforge.net/p/espeak/discussion/538920/thread/c6944a60/',
});

function encodePcm16MonoWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(samples[index], 44 + index * 2);
  }
  return buffer;
}

function decodePcm16MonoWav(buffer) {
  let sampleRate = null;
  let channels = null;
  let bitsPerSample = null;
  let dataOffset = null;
  let dataBytes = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkBytes = buffer.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    if (chunkId === 'fmt ') {
      channels = buffer.readUInt16LE(payloadOffset + 2);
      sampleRate = buffer.readUInt32LE(payloadOffset + 4);
      bitsPerSample = buffer.readUInt16LE(payloadOffset + 14);
    } else if (chunkId === 'data') {
      dataOffset = payloadOffset;
      dataBytes = chunkBytes;
      break;
    }
    offset = payloadOffset + chunkBytes + (chunkBytes % 2);
  }
  if (!sampleRate || channels !== 1 || bitsPerSample !== 16 || dataOffset === null || dataBytes === null) {
    throw new Error('generated speech must be PCM16 mono WAV');
  }
  const samples = new Int16Array(dataBytes / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = buffer.readInt16LE(dataOffset + index * 2);
  }
  return { sampleRate, samples };
}

function concatenateSamples(parts) {
  const totalSamples = parts.reduce((total, part) => total + part.length, 0);
  const output = new Int16Array(totalSamples);
  let cursor = 0;
  for (const part of parts) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return output;
}

function silenceSamples(durationMs, sampleRate) {
  return new Int16Array(Math.round((durationMs / 1000) * sampleRate));
}

function deterministicNoiseSamples(durationMs, sampleRate, peakAmplitude) {
  const samples = new Int16Array(Math.round((durationMs / 1000) * sampleRate));
  let state = 0x5eed1234;
  for (let index = 0; index < samples.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const unit = state / 0xffffffff;
    samples[index] = Math.round((unit * 2 - 1) * peakAmplitude);
  }
  return samples;
}

function coughLikeSamples(sampleRate) {
  const durationMs = 1800;
  const samples = deterministicNoiseSamples(durationMs, sampleRate, 1);
  let state = 0xc0ffee;
  for (let index = 0; index < samples.length; index += 1) {
    const timeMs = (index / sampleRate) * 1000;
    const first = timeMs >= 280 && timeMs <= 510
      ? Math.sin(((timeMs - 280) / 230) * Math.PI) ** 2
      : 0;
    const second = timeMs >= 720 && timeMs <= 970
      ? Math.sin(((timeMs - 720) / 250) * Math.PI) ** 2 * 0.72
      : 0;
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    const noise = state / 0xffffffff * 2 - 1;
    const lowCarrier = Math.sin((2 * Math.PI * 145 * index) / sampleRate);
    samples[index] = Math.round((noise * 0.72 + lowCarrier * 0.28) * (first + second) * 13_000);
  }
  return samples;
}

async function synthesizeSpeech({ text, voice, sampleRate, name, tempDir }) {
  const sourceWavPath = join(tempDir, `${name}.source.wav`);
  const wavPath = join(tempDir, `${name}.wav`);
  await execFileAsync(espeakCommand, ['-v', voice, '-w', sourceWavPath, text]);
  await execFileAsync(ffmpegCommand, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', sourceWavPath,
    '-ac', '1',
    '-ar', String(sampleRate),
    '-c:a', 'pcm_s16le',
    wavPath,
  ]);
  return decodePcm16MonoWav(await readFile(wavPath)).samples;
}

async function writeFixture(spec, samples) {
  const bytes = encodePcm16MonoWav(samples, spec.sampleRate);
  await writeFile(join(phrasesDir, spec.file), bytes);
  return {
    id: spec.id,
    file: `phrases/${spec.file}`,
    sourceText: spec.sourceText,
    language: spec.language,
    sampleRate: spec.sampleRate,
    channels: 1,
    durationMs: Math.round((samples.length / spec.sampleRate) * 1000),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    expectedTranscriptSubstrings: spec.expectedTranscriptSubstrings,
    timelineMs: spec.timelineMs,
    scenarios: spec.scenarios,
    provenance: spec.provenance,
  };
}

async function main() {
  await mkdir(phrasesDir, { recursive: true });
  const tempDir = await mkdtemp(join(tmpdir(), 'happier-voice-fixtures-'));
  try {
    const [{ stdout: ffmpegVersion }, espeakHelp] = await Promise.all([
      execFileAsync(ffmpegCommand, ['-version']),
      execFileAsync(espeakCommand, ['--help']),
    ]);
    const espeakVersionText = `${espeakHelp.stdout}\n${espeakHelp.stderr}`;
    if (!espeakVersionText.includes(espeakSource.version)) {
      throw new Error(
        `voice fixture generation requires pinned eSpeak ${espeakSource.version}; received ${espeakVersionText.split('\n').find(Boolean) ?? 'unknown version'}`,
      );
    }
    const provenanceBase = {
      generator: 'packages/tests/fixtures/voice/generate.mjs',
      license: 'Project-owned deterministic test fixture; no third-party media input.',
    };
    const speechProvenanceBase = {
      ...provenanceBase,
      speechEngine: 'eSpeak formant synthesis',
      normalizer: ffmpegVersion.split('\n')[0],
      license: 'Project-owned test fixture; eSpeak GPL does not apply to generated WAV output.',
      sourceVersion: espeakSource.version,
      sourceUrl: espeakSource.sourceUrl,
      sourceArchiveSha256: espeakSource.sourceArchiveSha256,
      engineLicense: espeakSource.engineLicense,
      outputLicenseEvidence: espeakSource.outputLicenseEvidence,
    };
    const deterministicProvenance = (speechEngine, seed) => ({
      ...provenanceBase,
      speechEngine,
      normalizer: 'direct PCM16 mono WAV encoder',
      algorithmVersion: '1',
      seed,
    });
    const speech = async (name, text, voice, sampleRate) => synthesizeSpeech({
      name,
      text,
      voice,
      sampleRate,
      tempDir,
    });

    const shortText = 'Open the project settings.';
    const longText = 'Summarize the latest changes, explain any failing checks, and wait for my confirmation before continuing.';
    const turnOneText = 'Start a new session.';
    const turnTwoText = 'Then open the project settings.';
    const bargeOneText = 'Please read the summary aloud.';
    const bargeTwoText = 'Stop. I have another question.';
    const frenchText = 'Ouvre les paramètres du projet.';

    const trailingSilenceMs = 900;
    const short16Speech = await speech('short-command-16k', shortText, 'en-us', 16_000);
    const short24Speech = await speech('short-command-24k', shortText, 'en-us', 24_000);
    const long16Speech = await speech('long-utterance-16k', longText, 'en-us', 16_000);
    const turnOne = await speech('two-turn-one-24k', turnOneText, 'en-us', 24_000);
    const turnTwo = await speech('two-turn-two-24k', turnTwoText, 'en-us', 24_000);
    const bargeOne = await speech('barge-one-24k', bargeOneText, 'en-us', 24_000);
    const bargeTwo = await speech('barge-two-24k', bargeTwoText, 'en-us', 24_000);
    const french16Speech = await speech('multilingual-fr-16k', frenchText, 'fr-fr', 16_000);

    const short16 = concatenateSamples([short16Speech, silenceSamples(trailingSilenceMs, 16_000)]);
    const short24 = concatenateSamples([short24Speech, silenceSamples(trailingSilenceMs, 24_000)]);
    const long16 = concatenateSamples([long16Speech, silenceSamples(trailingSilenceMs, 16_000)]);
    const french16 = concatenateSamples([french16Speech, silenceSamples(trailingSilenceMs, 16_000)]);

    const turnPauseMs = 1500;
    const twoTurns = concatenateSamples(
      [turnOne, silenceSamples(turnPauseMs, 24_000), turnTwo, silenceSamples(trailingSilenceMs, 24_000)],
    );
    const bargePauseMs = 650;
    const bargeTimeline = concatenateSamples(
      [bargeOne, silenceSamples(bargePauseMs, 24_000), bargeTwo, silenceSamples(trailingSilenceMs, 24_000)],
    );

    const specs = [
      {
        id: 'short-command-16k', file: 'short-command.16k.wav', sourceText: shortText, language: 'en-US',
        sampleRate: 16_000, expectedTranscriptSubstrings: ['open', 'project', 'settings'],
        timelineMs: [
          { kind: 'speech', start: 0, end: Math.round(short16Speech.length / 16) },
          { kind: 'silence', start: Math.round(short16Speech.length / 16), end: Math.round(short16.length / 16) },
        ],
        scenarios: ['daemon-stt-batch'], provenance: { ...speechProvenanceBase, voice: 'en-us' },
      },
      {
        id: 'short-command-24k', file: 'short-command.24k.wav', sourceText: shortText, language: 'en-US',
        sampleRate: 24_000, expectedTranscriptSubstrings: ['open', 'project', 'settings'],
        timelineMs: [
          { kind: 'speech', start: 0, end: Math.round(short24Speech.length / 24) },
          { kind: 'silence', start: Math.round(short24Speech.length / 24), end: Math.round(short24.length / 24) },
        ],
        scenarios: ['native-virtual-media', 'browser-capture'], provenance: { ...speechProvenanceBase, voice: 'en-us' },
      },
      {
        id: 'long-utterance-16k', file: 'long-utterance.16k.wav', sourceText: longText, language: 'en-US',
        sampleRate: 16_000, expectedTranscriptSubstrings: ['summarize', 'failing checks', 'confirmation'],
        timelineMs: [
          { kind: 'speech', start: 0, end: Math.round(long16Speech.length / 16) },
          { kind: 'silence', start: Math.round(long16Speech.length / 16), end: Math.round(long16.length / 16) },
        ],
        scenarios: ['streaming-stt', 'backpressure', 'cancellation', 'browser-capture'], provenance: { ...speechProvenanceBase, voice: 'en-us' },
      },
      {
        id: 'two-turns-with-pause-24k', file: 'two-turns-with-pause.24k.wav',
        sourceText: `${turnOneText} [${turnPauseMs}ms silence] ${turnTwoText}`, language: 'en-US', sampleRate: 24_000,
        expectedTranscriptSubstrings: ['start a new session', 'open the project settings'],
        timelineMs: [
          { kind: 'speech', start: 0, end: Math.round(turnOne.length / 24) },
          { kind: 'silence', start: Math.round(turnOne.length / 24), end: Math.round(turnOne.length / 24) + turnPauseMs },
          { kind: 'speech', start: Math.round(turnOne.length / 24) + turnPauseMs, end: Math.round((turnOne.length + turnPauseMs * 24 + turnTwo.length) / 24) },
          { kind: 'silence', start: Math.round((turnOne.length + turnPauseMs * 24 + turnTwo.length) / 24), end: Math.round(twoTurns.length / 24) },
        ],
        scenarios: ['endpointing', 'multi-turn'], provenance: { ...speechProvenanceBase, voice: 'en-us' },
      },
      {
        id: 'barge-in-timeline-24k', file: 'barge-in-timeline.24k.wav',
        sourceText: `${bargeOneText} [${bargePauseMs}ms silence] ${bargeTwoText}`, language: 'en-US', sampleRate: 24_000,
        expectedTranscriptSubstrings: ['read the summary', 'another question'],
        timelineMs: [
          { kind: 'speech', start: 0, end: Math.round(bargeOne.length / 24) },
          { kind: 'silence', start: Math.round(bargeOne.length / 24), end: Math.round(bargeOne.length / 24) + bargePauseMs },
          { kind: 'barge_in_speech', start: Math.round(bargeOne.length / 24) + bargePauseMs, end: Math.round((bargeOne.length + bargePauseMs * 24 + bargeTwo.length) / 24) },
          { kind: 'silence', start: Math.round((bargeOne.length + bargePauseMs * 24 + bargeTwo.length) / 24), end: Math.round(bargeTimeline.length / 24) },
        ],
        scenarios: ['barge-in', 'cancellation-boundary'], provenance: { ...speechProvenanceBase, voice: 'en-us' },
      },
      {
        id: 'multilingual-fr-16k', file: 'multilingual-fr.16k.wav', sourceText: frenchText, language: 'fr-FR',
        sampleRate: 16_000, expectedTranscriptSubstrings: ['ouvre', 'paramètres', 'projet'],
        timelineMs: [
          { kind: 'speech', start: 0, end: Math.round(french16Speech.length / 16) },
          { kind: 'silence', start: Math.round(french16Speech.length / 16), end: Math.round(french16.length / 16) },
        ],
        scenarios: ['language-selection', 'multilingual-stt'], provenance: { ...speechProvenanceBase, voice: 'fr-fr' },
      },
      {
        id: 'silence-5s', file: 'silence-5s.wav', sourceText: null, language: null, sampleRate: 16_000,
        expectedTranscriptSubstrings: [], timelineMs: [{ kind: 'silence', start: 0, end: 5000 }],
        scenarios: ['silence', 'endpoint-timeout'], provenance: deterministicProvenance('deterministic PCM generator', 'zero-filled'),
      },
      {
        id: 'low-noise', file: 'low-noise.wav', sourceText: null, language: null, sampleRate: 16_000,
        expectedTranscriptSubstrings: [], timelineMs: [{ kind: 'low_noise', start: 0, end: 5000 }],
        scenarios: ['noise-rejection', 'false-endpoint'], provenance: deterministicProvenance('seeded PCM noise generator', '0x5eed1234'),
      },
      {
        id: 'transient-cough-like', file: 'transient-cough-like.wav', sourceText: null, language: null, sampleRate: 24_000,
        expectedTranscriptSubstrings: [], timelineMs: [
          { kind: 'silence', start: 0, end: 280 },
          { kind: 'transient', start: 280, end: 510 },
          { kind: 'silence', start: 510, end: 720 },
          { kind: 'transient', start: 720, end: 970 },
          { kind: 'silence', start: 970, end: 1800 },
        ],
        scenarios: ['false-interruption', 'noise-rejection'], provenance: deterministicProvenance('seeded shaped-noise generator', '0xc0ffee'),
      },
    ];

    const samplesById = new Map([
      ['short-command-16k', short16],
      ['short-command-24k', short24],
      ['short-command-48k', short48],
      ['long-utterance-16k', long16],
      ['two-turns-with-pause-24k', twoTurns],
      ['barge-in-timeline-24k', bargeTimeline],
      ['multilingual-fr-16k', french16],
      ['silence-5s', silenceSamples(5000, 16_000)],
      ['low-noise', deterministicNoiseSamples(5000, 16_000, 180)],
      ['transient-cough-like', coughLikeSamples(24_000)],
    ]);

    const fixtures = [];
    for (const spec of specs) {
      fixtures.push(await writeFixture(spec, samplesById.get(spec.id)));
    }
    await writeFile(
      join(fixtureRoot, 'manifest.json'),
      `${JSON.stringify({ schemaVersion: 1, fixtures }, null, 2)}\n`,
      'utf8',
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
