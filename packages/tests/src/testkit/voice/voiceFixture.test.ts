import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

import {
    matchesVoiceFixtureTranscript,
    normalizeVoiceFixtureTranscript,
    parseVoiceFixturePcm16Wav,
    parseVoiceFixtureManifest,
    readKnownVoiceFixtureByPath,
    readVoiceFixture,
    readVoiceFixturePcm16,
} from './voiceFixture';

function createValidManifestFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'fixture-one',
        file: 'phrases/fixture-one.16k.wav',
        sourceText: 'Test fixture one.',
        language: 'en-US',
        sampleRate: 16_000,
        channels: 1,
        durationMs: 1_500,
        sha256: 'a'.repeat(64),
        expectedTranscriptSubstrings: ['test', 'fixture'],
        timelineMs: [
            { kind: 'speech', start: 0, end: 700 },
            { kind: 'silence', start: 700, end: 1_500 },
        ],
        scenarios: ['daemon-stt-batch'],
        provenance: {
            generator: 'test generator',
            speechEngine: 'test engine',
            normalizer: 'test normalizer',
            license: 'test output license',
            sourceVersion: '1.0.0',
            sourceUrl: 'https://example.test/synthesizer',
            sourceArchiveSha256: 'b'.repeat(64),
            engineLicense: 'test engine license',
            outputLicenseEvidence: 'https://example.test/output-license',
            voice: 'test-voice',
        },
        ...overrides,
    };
}

function createPcmWav(overrides: Readonly<{
    riffId?: 'RIFF' | 'RIFX';
    audioFormat?: number;
    channels?: number;
    sampleRate?: number;
    byteRate?: number;
    blockAlign?: number;
    bitsPerSample?: number;
    pcmBytes?: Buffer;
    duplicateData?: boolean;
}> = {}): Buffer {
    const sampleRate = overrides.sampleRate ?? 16_000;
    const channels = overrides.channels ?? 1;
    const bitsPerSample = overrides.bitsPerSample ?? 16;
    const blockAlign = overrides.blockAlign ?? channels * bitsPerSample / 8;
    const pcmBytes = overrides.pcmBytes ?? Buffer.alloc(32);
    const dataChunks = overrides.duplicateData ? [pcmBytes, pcmBytes] : [pcmBytes];
    const totalBytes = 12 + 24 + dataChunks.reduce((sum, bytes) => sum + 8 + bytes.byteLength, 0);
    const wav = Buffer.alloc(totalBytes);
    let offset = 0;
    wav.write(overrides.riffId ?? 'RIFF', offset, 'ascii');
    wav.writeUInt32LE(totalBytes - 8, offset + 4);
    wav.write('WAVE', offset + 8, 'ascii');
    offset += 12;
    wav.write('fmt ', offset, 'ascii');
    wav.writeUInt32LE(16, offset + 4);
    wav.writeUInt16LE(overrides.audioFormat ?? 1, offset + 8);
    wav.writeUInt16LE(channels, offset + 10);
    wav.writeUInt32LE(sampleRate, offset + 12);
    wav.writeUInt32LE(overrides.byteRate ?? sampleRate * blockAlign, offset + 16);
    wav.writeUInt16LE(blockAlign, offset + 20);
    wav.writeUInt16LE(bitsPerSample, offset + 22);
    offset += 24;
    for (const bytes of dataChunks) {
        wav.write('data', offset, 'ascii');
        wav.writeUInt32LE(bytes.byteLength, offset + 4);
        bytes.copy(wav, offset + 8);
        offset += 8 + bytes.byteLength;
    }
    return wav;
}

function insertWavChunk(
    wav: Buffer,
    offset: number,
    chunkId: string,
    chunkBytes: Buffer,
    declaredSize = chunkBytes.byteLength,
): Buffer {
    const chunk = Buffer.alloc(8 + chunkBytes.byteLength + (chunkBytes.byteLength % 2));
    chunk.write(chunkId, 0, 'ascii');
    chunk.writeUInt32LE(declaredSize, 4);
    chunkBytes.copy(chunk, 8);
    const result = Buffer.concat([wav.subarray(0, offset), chunk, wav.subarray(offset)]);
    result.writeUInt32LE(result.byteLength - 8, 4);
    return result;
}

describe('voice fixture testkit', () => {
    it('loads a checked-in PCM fixture and its manifest contract', async () => {
        const fixture = await readVoiceFixture('short-command-16k');

        expect(fixture.metadata.file).toBe('phrases/short-command.16k.wav');
        expect(fixture.metadata.sampleRate).toBe(16_000);
        expect(fixture.bytes.subarray(0, 4).toString('ascii')).toBe('RIFF');
        expect(fixture.bytes.subarray(8, 12).toString('ascii')).toBe('WAVE');
        expect(matchesVoiceFixtureTranscript(fixture.metadata, 'Please OPEN the project settings now.')).toBe(true);
        expect(matchesVoiceFixtureTranscript(fixture.metadata, 'Open something unrelated.')).toBe(false);
        expect(Object.isFrozen(fixture.metadata)).toBe(true);
        expect(Object.isFrozen(fixture.metadata.timelineMs)).toBe(true);
        expect(Object.isFrozen(fixture.metadata.expectedTranscriptSubstrings)).toBe(true);
        expect(Object.isFrozen(fixture.metadata.provenance)).toBe(true);
    });

    it('resolves an absolute configured path back to its checked-in fixture contract', async () => {
        const fixturePath = fileURLToPath(new URL(
            '../../../fixtures/voice/phrases/long-utterance.16k.wav',
            import.meta.url,
        ));

        const fixture = await readKnownVoiceFixtureByPath(fixturePath);

        expect(fixture?.metadata.id).toBe('long-utterance-16k');
        expect(fixture?.metadata.expectedTranscriptSubstrings).toContain('confirmation');
    });

    it('normalizes case, punctuation, whitespace, and accents for nondeterministic STT oracles', () => {
        expect(normalizeVoiceFixtureTranscript('  OUVRE, les PARAMÈTRES\n du projet! ')).toBe(
            'ouvre les parametres du projet',
        );
    });

    it('exposes canonical PCM16 payload bytes without leaking WAV container bytes into stream consumers', async () => {
        const fixture = await readVoiceFixturePcm16('long-utterance-16k');

        expect(fixture.sampleRateHz).toBe(16_000);
        expect(fixture.channelCount).toBe(1);
        expect(fixture.bitsPerSample).toBe(16);
        expect(fixture.pcm16Bytes.byteLength).toBeGreaterThan(100_000);
        expect(fixture.pcm16Bytes.byteLength % 2).toBe(0);
        expect(Buffer.from(fixture.pcm16Bytes.subarray(0, 4)).toString('ascii')).not.toBe('RIFF');
    });

    it('rejects non-canonical, inconsistent, duplicate, and truncated PCM WAV containers', () => {
        const expected = { id: 'fixture-wav', sampleRate: 16_000, durationMs: 1 } as const;
        expect(parseVoiceFixturePcm16Wav(expected, createPcmWav()).pcm16Bytes).toHaveLength(32);
        expect(parseVoiceFixturePcm16Wav(
            expected,
            insertWavChunk(createPcmWav(), 36, 'JUNK', Buffer.from([1, 2, 3])),
        ).pcm16Bytes).toHaveLength(32);

        const invalidRiffSize = createPcmWav();
        invalidRiffSize.writeUInt32LE(invalidRiffSize.byteLength - 9, 4);
        const invalidWaveId = createPcmWav();
        invalidWaveId.write('AVI ', 8, 'ascii');
        const missingFormat = createPcmWav();
        missingFormat.write('JUNK', 12, 'ascii');
        const missingData = createPcmWav();
        missingData.write('JUNK', 36, 'ascii');
        const truncatedChunk = createPcmWav();
        truncatedChunk.writeUInt32LE(64, 40);
        const truncatedExtraChunk = insertWavChunk(createPcmWav(), 36, 'JUNK', Buffer.alloc(0), 8);
        const duplicateFormat = insertWavChunk(
            createPcmWav(),
            36,
            'fmt ',
            createPcmWav().subarray(20, 36),
        );

        for (const wav of [
            createPcmWav({ riffId: 'RIFX' }),
            invalidRiffSize,
            invalidWaveId,
            missingFormat,
            missingData,
            truncatedChunk,
            truncatedExtraChunk,
            duplicateFormat,
            createPcmWav({ audioFormat: 3 }),
            createPcmWav({ channels: 2 }),
            createPcmWav({ bitsPerSample: 8 }),
            createPcmWav({ blockAlign: 4 }),
            createPcmWav({ byteRate: 1 }),
            createPcmWav({ pcmBytes: Buffer.alloc(31) }),
            createPcmWav({ duplicateData: true }),
        ]) {
            expect(() => parseVoiceFixturePcm16Wav(expected, wav)).toThrow(/voice fixture/);
        }

        expect(() => parseVoiceFixturePcm16Wav(
            { ...expected, durationMs: 500 },
            createPcmWav(),
        )).toThrow(/voice fixture/);
    });

    it('rejects unknown fixture ids instead of silently selecting a default', async () => {
        await expect(readVoiceFixture('missing-fixture')).rejects.toThrow(/unknown voice fixture/);
    });

    it('rejects traversal, duplicate identities, and malformed timeline metadata at the manifest boundary', () => {
        expect(() => parseVoiceFixtureManifest({
            schemaVersion: 1,
            fixtures: [createValidManifestFixture({ file: 'phrases/../../outside.wav' })],
        })).toThrow(/invalid voice fixture entry/);

        expect(() => parseVoiceFixtureManifest({
            schemaVersion: 1,
            fixtures: [createValidManifestFixture(), createValidManifestFixture()],
        })).toThrow(/duplicate voice fixture id/);

        expect(() => parseVoiceFixtureManifest({
            schemaVersion: 1,
            fixtures: [createValidManifestFixture({
                timelineMs: [
                    { kind: 'speech', start: 0, end: 900 },
                    { kind: 'silence', start: 800, end: 1_500 },
                ],
            })],
        })).toThrow(/invalid voice fixture timeline/);

        expect(() => parseVoiceFixtureManifest({
            schemaVersion: 1,
            fixtures: [createValidManifestFixture({
                timelineMs: [
                    { kind: 'speech', start: 0, end: 700 },
                    { kind: 'silence', start: 800, end: 1_500 },
                ],
            })],
        })).toThrow(/invalid voice fixture timeline/);

        expect(() => parseVoiceFixtureManifest({
            schemaVersion: 1,
            fixtures: [createValidManifestFixture({
                provenance: {
                    generator: 'test generator',
                    speechEngine: 'test engine',
                    normalizer: 'test normalizer',
                    license: 'test output license',
                },
            })],
        })).toThrow(/invalid voice fixture provenance/);
    });

    it('treats any lexical STT output for silence and noise fixtures as a failed oracle', async () => {
        const silence = await readVoiceFixture('silence-5s');
        const noise = await readVoiceFixture('low-noise');

        expect(matchesVoiceFixtureTranscript(silence.metadata, '')).toBe(true);
        expect(matchesVoiceFixtureTranscript(noise.metadata, '   ...   ')).toBe(true);
        expect(matchesVoiceFixtureTranscript(silence.metadata, 'hello')).toBe(false);
        expect(matchesVoiceFixtureTranscript(noise.metadata, '[background noise]')).toBe(false);
        expect(noise.metadata.provenance.algorithmVersion).toBe('1');
        expect(noise.metadata.provenance.seed).toBe('0x5eed1234');
        expect(noise.metadata.provenance.sourceUrl).toBeUndefined();
    });
});
