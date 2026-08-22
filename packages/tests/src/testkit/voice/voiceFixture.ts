import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVoiceWavContainer } from './voiceWavParser.mjs';

export interface VoiceFixtureTimelineEntry {
    readonly kind: string;
    readonly start: number;
    readonly end: number;
}

export interface VoiceFixtureMetadata {
    readonly id: string;
    readonly file: string;
    readonly sourceText: string | null;
    readonly language: string | null;
    readonly sampleRate: number;
    readonly channels: 1;
    readonly durationMs: number;
    readonly sha256: string;
    readonly expectedTranscriptSubstrings: readonly string[];
    readonly timelineMs: readonly VoiceFixtureTimelineEntry[];
    readonly scenarios: readonly string[];
    readonly provenance: Readonly<{
        generator: string;
        speechEngine: string;
        normalizer: string;
        license: string;
        sourceVersion?: string;
        sourceUrl?: string;
        sourceArchiveSha256?: string;
        engineLicense?: string;
        outputLicenseEvidence?: string;
        voice?: string;
        algorithmVersion?: string;
        seed?: string;
    }>;
}

interface VoiceFixtureManifestV1 {
    readonly schemaVersion: 1;
    readonly fixtures: readonly VoiceFixtureMetadata[];
}

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/voice');
let manifestPromise: Promise<VoiceFixtureManifestV1> | null = null;

const fixtureIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const fixtureFilePattern = /^phrases\/[a-z0-9][a-z0-9.-]*\.wav$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown, allowEmpty: boolean): value is string[] {
    return Array.isArray(value)
        && (allowEmpty || value.length > 0)
        && value.every(isNonEmptyString);
}

function parseTimeline(value: unknown, durationMs: number): readonly VoiceFixtureTimelineEntry[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('invalid voice fixture timeline');
    }

    let previousEnd = 0;
    const timeline = Object.freeze(value.map((candidate) => {
        if (!isRecord(candidate)) throw new Error('invalid voice fixture timeline');
        const { kind, start, end } = candidate;
        if (
            !isNonEmptyString(kind)
            || typeof start !== 'number'
            || !Number.isInteger(start)
            || start < 0
            || typeof end !== 'number'
            || !Number.isInteger(end)
            || end <= start
            || end > durationMs
            || start !== previousEnd
        ) {
            throw new Error('invalid voice fixture timeline');
        }
        previousEnd = end;
        return Object.freeze({ kind, start, end });
    }));
    if (previousEnd !== durationMs) throw new Error('invalid voice fixture timeline');
    return timeline;
}

function parseProvenance(value: unknown, requiresSpeechSource: boolean): VoiceFixtureMetadata['provenance'] {
    if (!isRecord(value)) throw new Error('invalid voice fixture provenance');
    if (
        !isNonEmptyString(value.generator)
        || !isNonEmptyString(value.speechEngine)
        || !isNonEmptyString(value.normalizer)
        || !isNonEmptyString(value.license)
    ) {
        throw new Error('invalid voice fixture provenance');
    }
    const base = {
        generator: value.generator,
        speechEngine: value.speechEngine,
        normalizer: value.normalizer,
        license: value.license,
    };
    if (requiresSpeechSource) {
        if (
            !isNonEmptyString(value.sourceVersion)
            || !isNonEmptyString(value.sourceUrl)
            || !URL.canParse(value.sourceUrl)
            || !isNonEmptyString(value.sourceArchiveSha256)
            || !sha256Pattern.test(value.sourceArchiveSha256)
            || !isNonEmptyString(value.engineLicense)
            || !isNonEmptyString(value.outputLicenseEvidence)
            || !URL.canParse(value.outputLicenseEvidence)
            || !isNonEmptyString(value.voice)
            || value.algorithmVersion !== undefined
            || value.seed !== undefined
        ) {
            throw new Error('invalid voice fixture provenance');
        }
        return Object.freeze({
            ...base,
            sourceVersion: value.sourceVersion,
            sourceUrl: value.sourceUrl,
            sourceArchiveSha256: value.sourceArchiveSha256,
            engineLicense: value.engineLicense,
            outputLicenseEvidence: value.outputLicenseEvidence,
            voice: value.voice,
        });
    }
    if (
        !isNonEmptyString(value.algorithmVersion)
        || !isNonEmptyString(value.seed)
        || value.sourceVersion !== undefined
        || value.sourceUrl !== undefined
        || value.sourceArchiveSha256 !== undefined
        || value.engineLicense !== undefined
        || value.outputLicenseEvidence !== undefined
        || value.voice !== undefined
    ) {
        throw new Error('invalid voice fixture provenance');
    }
    return Object.freeze({
        ...base,
        algorithmVersion: value.algorithmVersion,
        seed: value.seed,
    });
}

export function parseVoiceFixtureManifest(value: unknown): VoiceFixtureManifestV1 {
    if (!value || typeof value !== 'object') throw new Error('invalid voice fixture manifest');
    const candidate = value as { schemaVersion?: unknown; fixtures?: unknown };
    if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.fixtures)) {
        throw new Error('invalid voice fixture manifest');
    }

    const ids = new Set<string>();
    const files = new Set<string>();
    const fixtures: VoiceFixtureMetadata[] = candidate.fixtures.map((fixture) => {
        if (!isRecord(fixture)) throw new Error('invalid voice fixture entry');
        const entry = fixture;
        if (
            !isNonEmptyString(entry.id)
            || !fixtureIdPattern.test(entry.id)
            || !isNonEmptyString(entry.file)
            || !fixtureFilePattern.test(entry.file)
            || (entry.sourceText !== null && !isNonEmptyString(entry.sourceText))
            || (entry.language !== null && !isNonEmptyString(entry.language))
            || typeof entry.sampleRate !== 'number'
            || !Number.isInteger(entry.sampleRate)
            || entry.sampleRate <= 0
            || entry.channels !== 1
            || typeof entry.durationMs !== 'number'
            || !Number.isInteger(entry.durationMs)
            || entry.durationMs <= 0
            || !isNonEmptyString(entry.sha256)
            || !sha256Pattern.test(entry.sha256)
            || !isStringArray(entry.expectedTranscriptSubstrings, entry.sourceText === null)
            || !isStringArray(entry.scenarios, false)
        ) {
            throw new Error('invalid voice fixture entry');
        }

        if (ids.has(entry.id)) throw new Error(`duplicate voice fixture id: ${entry.id}`);
        if (files.has(entry.file)) throw new Error(`duplicate voice fixture file: ${entry.file}`);
        ids.add(entry.id);
        files.add(entry.file);

        const timelineMs = parseTimeline(entry.timelineMs, entry.durationMs);
        if (entry.sourceText !== null) {
            if (entry.language === null) throw new Error('invalid voice fixture entry');
            const trailingWindow = timelineMs.at(-1);
            if (
                trailingWindow?.kind !== 'silence'
                || trailingWindow.end !== entry.durationMs
                || trailingWindow.end - trailingWindow.start < 500
            ) {
                throw new Error('invalid voice fixture timeline');
            }
        } else if (entry.expectedTranscriptSubstrings.length !== 0) {
            throw new Error('invalid voice fixture entry');
        }

        return Object.freeze({
            id: entry.id,
            file: entry.file,
            sourceText: entry.sourceText,
            language: entry.language,
            sampleRate: entry.sampleRate,
            channels: 1,
            durationMs: entry.durationMs,
            sha256: entry.sha256,
            expectedTranscriptSubstrings: Object.freeze([...entry.expectedTranscriptSubstrings]),
            timelineMs,
            scenarios: Object.freeze([...entry.scenarios]),
            provenance: parseProvenance(entry.provenance, entry.sourceText !== null),
        });
    });
    return Object.freeze({ schemaVersion: 1, fixtures: Object.freeze(fixtures) });
}

async function readManifest(): Promise<VoiceFixtureManifestV1> {
    manifestPromise ??= readFile(resolve(fixtureRoot, 'manifest.json'), 'utf8')
        .then((text) => parseVoiceFixtureManifest(JSON.parse(text)));
    return manifestPromise;
}

function resolveFixturePath(relativePath: string): string {
    const absolutePath = resolve(fixtureRoot, relativePath);
    if (!absolutePath.startsWith(`${fixtureRoot}${sep}`)) {
        throw new Error('voice fixture path escapes fixture root');
    }
    return absolutePath;
}

export function normalizeVoiceFixtureTranscript(value: string): string {
    return value
        .normalize('NFKD')
        .replace(/\p{Mark}/gu, '')
        .toLocaleLowerCase('en-US')
        .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

export function matchesVoiceFixtureTranscript(
    metadata: Pick<VoiceFixtureMetadata, 'expectedTranscriptSubstrings'>,
    transcript: string,
): boolean {
    const normalizedTranscript = normalizeVoiceFixtureTranscript(transcript);
    if (metadata.expectedTranscriptSubstrings.length === 0) return normalizedTranscript.length === 0;
    return metadata.expectedTranscriptSubstrings.every((substring) =>
        normalizedTranscript.includes(normalizeVoiceFixtureTranscript(substring)),
    );
}

export async function readVoiceFixture(id: string): Promise<Readonly<{
    metadata: VoiceFixtureMetadata;
    bytes: Buffer;
}>> {
    const manifest = await readManifest();
    const metadata = manifest.fixtures.find((fixture) => fixture.id === id);
    if (!metadata) throw new Error(`unknown voice fixture: ${id}`);

    const path = resolveFixturePath(metadata.file);
    const fileStat = await lstat(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new Error(`voice fixture must be a regular file: ${id}`);
    }
    const [canonicalRoot, canonicalPath] = await Promise.all([realpath(fixtureRoot), realpath(path)]);
    if (!canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
        throw new Error(`voice fixture path escapes fixture root: ${id}`);
    }

    const bytes = await readFile(canonicalPath);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== metadata.sha256) {
        throw new Error(`voice fixture digest mismatch: ${id}`);
    }
    return { metadata, bytes };
}

export async function readKnownVoiceFixtureByPath(path: string): Promise<Readonly<{
    metadata: VoiceFixtureMetadata;
    bytes: Buffer;
}> | null> {
    const [manifest, canonicalPath] = await Promise.all([readManifest(), realpath(path)]);
    for (const metadata of manifest.fixtures) {
        const canonicalFixturePath = await realpath(resolveFixturePath(metadata.file));
        if (canonicalFixturePath === canonicalPath) {
            return await readVoiceFixture(metadata.id);
        }
    }
    return null;
}

export function measureVoiceWavDurationMs(bytes: Uint8Array): number {
    const container = parseVoiceWavContainer(bytes, 'custom-wav');
    const dataByteLength = container.dataBytes.byteLength;
    if (!Number.isSafeInteger(container.format.byteRate)) {
        throw new Error('voice fixture WAV duration unavailable');
    }
    const durationMs = dataByteLength / container.format.byteRate * 1_000;
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new Error('voice fixture WAV duration unavailable');
    }
    return durationMs;
}

export async function readVoiceWavDurationMs(path: string): Promise<number> {
    return measureVoiceWavDurationMs(await readFile(path));
}

export function parseVoiceFixturePcm16Wav<
    TMetadata extends Pick<VoiceFixtureMetadata, 'id' | 'sampleRate' | 'durationMs'>,
>(
    metadata: TMetadata,
    bytes: Uint8Array,
): Readonly<{
    metadata: TMetadata;
    sampleRateHz: number;
    channelCount: 1;
    bitsPerSample: 16;
    pcm16Bytes: Uint8Array;
}> {
    const id = metadata.id;
    const container = parseVoiceWavContainer(bytes, id);
    const pcm16Bytes = container.dataBytes;
    const format = container.format;

    if (
        format.sampleRateHz !== metadata.sampleRate
    ) {
        throw new Error(`voice fixture WAV sample rate mismatch: ${id}`);
    }
    const measuredDurationMs = pcm16Bytes.byteLength / format.byteRate * 1_000;
    if (Math.abs(measuredDurationMs - metadata.durationMs) > 2) {
        throw new Error(`voice fixture WAV duration mismatch: ${id}`);
    }

    return Object.freeze({
        metadata,
        sampleRateHz: format.sampleRateHz,
        channelCount: 1,
        bitsPerSample: 16,
        pcm16Bytes,
    });
}

export async function readVoiceFixturePcm16(id: string): Promise<Readonly<{
    metadata: VoiceFixtureMetadata;
    sampleRateHz: number;
    channelCount: 1;
    bitsPerSample: 16;
    pcm16Bytes: Uint8Array;
}>> {
    const fixture = await readVoiceFixture(id);
    return parseVoiceFixturePcm16Wav(fixture.metadata, fixture.bytes);
}
