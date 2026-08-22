import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parseVoiceWavContainer } from '../../src/testkit/voice/voiceWavParser.mjs';

const fixtureRoot = dirname(fileURLToPath(import.meta.url));

function readPcm16MonoWavHeader(buffer) {
  const container = parseVoiceWavContainer(buffer, 'manifest fixture');
  return {
    ...container.format,
    channels: container.format.channelCount,
    sampleRate: container.format.sampleRateHz,
    dataBytes: container.dataBytes.byteLength,
    dataOffset: container.dataOffset,
  };
}

function createPcmWav({ fmtChunkBytes = 16, dataBytes = Buffer.alloc(32) } = {}) {
  const fmtPayload = Buffer.alloc(fmtChunkBytes);
  fmtPayload.writeUInt16LE(1, 0);
  fmtPayload.writeUInt16LE(1, 2);
  fmtPayload.writeUInt32LE(8_000, 4);
  fmtPayload.writeUInt32LE(16_000, 8);
  fmtPayload.writeUInt16LE(2, 12);
  fmtPayload.writeUInt16LE(16, 14);
  const paddedFmtBytes = fmtChunkBytes + (fmtChunkBytes % 2);
  const paddedDataBytes = dataBytes.byteLength + (dataBytes.byteLength % 2);
  const buffer = Buffer.alloc(12 + 8 + paddedFmtBytes + 8 + paddedDataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVE', 8, 'ascii');
  let offset = 12;
  buffer.write('fmt ', offset, 'ascii');
  buffer.writeUInt32LE(fmtChunkBytes, offset + 4);
  fmtPayload.copy(buffer, offset + 8);
  offset += 8 + paddedFmtBytes;
  buffer.write('data', offset, 'ascii');
  buffer.writeUInt32LE(dataBytes.byteLength, offset + 4);
  dataBytes.copy(buffer, offset + 8);
  return buffer;
}

test('manifest WAV parser rejects extended fmt and empty data containers', () => {
  assert.throws(() => parseVoiceWavContainer(createPcmWav({ fmtChunkBytes: 18 }), 'manifest fixture'));
  assert.throws(() => parseVoiceWavContainer(createPcmWav({ dataBytes: Buffer.alloc(0) }), 'manifest fixture'));
});

test('checked-in voice fixtures match their manifest and PCM contract', async () => {
  const manifest = JSON.parse(await readFile(join(fixtureRoot, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(Array.isArray(manifest.fixtures));
  assert.ok(manifest.fixtures.length >= 9, 'coverage kit must include speech, timing, silence, and noise fixtures');

  const ids = new Set();
  for (const fixture of manifest.fixtures) {
    assert.ok(fixture.id && !ids.has(fixture.id), `fixture id must be unique: ${fixture.id}`);
    ids.add(fixture.id);
    assert.match(fixture.file, /^phrases\/[a-z0-9][a-z0-9.-]*\.wav$/, `${fixture.id}: canonical WAV path required`);
    assert.ok(Array.isArray(fixture.scenarios) && fixture.scenarios.length > 0, `${fixture.id}: scenarios required`);
    assert.ok(Array.isArray(fixture.timelineMs) && fixture.timelineMs.length > 0, `${fixture.id}: timeline required`);
    assert.ok(fixture.provenance?.generator, `${fixture.id}: provenance required`);
    assert.ok(fixture.provenance?.license, `${fixture.id}: output license required`);
    if (fixture.sourceText) {
      assert.doesNotMatch(
        fixture.provenance.speechEngine,
        /macOS say|Apple System Voice/i,
        `${fixture.id}: redistributable fixtures cannot use Apple System Voice output`,
      );
      assert.match(fixture.provenance.sourceUrl ?? '', /^https:\/\//, `${fixture.id}: synthesis source URL required`);
      assert.ok(fixture.provenance.sourceVersion, `${fixture.id}: pinned synthesis version required`);
      assert.match(fixture.provenance.sourceArchiveSha256 ?? '', /^[a-f0-9]{64}$/, `${fixture.id}: synthesis archive digest required`);
      assert.ok(fixture.provenance.engineLicense, `${fixture.id}: synthesis engine license required`);
      assert.match(fixture.provenance.outputLicenseEvidence ?? '', /^https:\/\//, `${fixture.id}: output license evidence required`);
    } else {
      assert.ok(fixture.provenance.algorithmVersion, `${fixture.id}: deterministic algorithm version required`);
      assert.ok(fixture.provenance.seed, `${fixture.id}: deterministic seed/basis required`);
      assert.equal(fixture.provenance.sourceUrl, undefined, `${fixture.id}: deterministic PCM must not claim a speech source`);
      assert.equal(fixture.provenance.sourceArchiveSha256, undefined, `${fixture.id}: deterministic PCM must not claim a speech archive`);
    }

    const fixturePath = resolve(fixtureRoot, fixture.file);
    const fixtureRelativePath = relative(fixtureRoot, fixturePath);
    assert.ok(
      fixtureRelativePath.length > 0
        && fixtureRelativePath !== '..'
        && !fixtureRelativePath.startsWith(`..${sep}`),
      `${fixture.id}: path must stay under fixture root`,
    );
    const bytes = await readFile(fixturePath);
    const header = readPcm16MonoWavHeader(bytes);
    const digest = createHash('sha256').update(bytes).digest('hex');
    assert.equal(digest, fixture.sha256, `${fixture.id}: digest mismatch`);
    assert.equal(header.sampleRate, fixture.sampleRate, `${fixture.id}: sample rate mismatch`);
    assert.equal(header.channels, fixture.channels, `${fixture.id}: channel mismatch`);
    const measuredDurationMs = (header.dataBytes / (header.sampleRate * header.channels * 2)) * 1000;
    assert.ok(
      Math.abs(measuredDurationMs - fixture.durationMs) <= 2,
      `${fixture.id}: duration differs (manifest=${fixture.durationMs}, measured=${measuredDurationMs})`,
    );
    let previousEnd = 0;
    for (const window of fixture.timelineMs) {
      assert.ok(typeof window.kind === 'string' && window.kind.length > 0, `${fixture.id}: timeline kind required`);
      assert.ok(Number.isInteger(window.start) && window.start === previousEnd, `${fixture.id}: timeline must be contiguous`);
      assert.ok(Number.isInteger(window.end) && window.end > window.start, `${fixture.id}: timeline window must be positive`);
      assert.ok(window.end <= fixture.durationMs, `${fixture.id}: timeline exceeds fixture duration`);
      previousEnd = window.end;

      if (window.kind === 'silence') {
        const firstSample = Math.round((window.start / 1000) * header.sampleRate);
        const totalSamples = header.dataBytes / header.blockAlign;
        const lastSample = Math.min(totalSamples, Math.round((window.end / 1000) * header.sampleRate));
        for (
          let byteOffset = header.dataOffset + firstSample * header.blockAlign;
          byteOffset < header.dataOffset + lastSample * header.blockAlign;
          byteOffset += header.blockAlign
        ) {
          assert.equal(bytes.readInt16LE(byteOffset), 0, `${fixture.id}: declared silence contains audio`);
        }
      }
    }
    assert.equal(previousEnd, fixture.durationMs, `${fixture.id}: timeline must cover the complete fixture`);
    if (fixture.sourceText) {
      const tail = fixture.timelineMs.at(-1);
      assert.equal(tail?.kind, 'silence', `${fixture.id}: speech fixture must declare a trailing-silence window`);
      assert.ok(tail.end - tail.start >= 500, `${fixture.id}: trailing silence must be at least 500ms`);
      assert.equal(tail.end, fixture.durationMs, `${fixture.id}: trailing silence must end with the fixture`);

    }
  }

  for (const requiredId of [
    'short-command-16k',
    'short-command-24k',
    'long-utterance-16k',
    'two-turns-with-pause-24k',
    'barge-in-timeline-24k',
    'multilingual-fr-16k',
    'silence-5s',
    'low-noise',
    'transient-cough-like',
  ]) {
    assert.ok(ids.has(requiredId), `missing required fixture ${requiredId}`);
  }
});
