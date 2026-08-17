import { readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import * as asyncProjection from './async.js';
import type {
    CoalescedScheduler as ProjectedCoalescedScheduler,
    RaceWithTimeoutResult as ProjectedRaceWithTimeoutResult,
} from './async.js';
import type { CoalescedScheduler as SourceCoalescedScheduler } from './runtime/coalescedScheduler.js';
import { createCoalescedScheduler as sourceCreateCoalescedScheduler } from './runtime/coalescedScheduler.js';
import type { RaceWithTimeoutResult as SourceRaceWithTimeoutResult } from './timeout.js';
import * as timeoutSource from './timeout.js';

import * as fsProjection from './fs.js';
import type {
    FsAtomicWriteJsonInput,
    FsAtomicWriteJsonInputV1,
    FsAtomicWriteTextInput,
    FsAtomicWriteTextInputV1,
    FileSystemService,
    SecureTempTextFileInput,
} from './fs.js';
import type { FileSystemService as RuntimeFileSystemService } from './runtime/index.js';
import type { SecureTempTextFileInputV1 } from './runtime/tempTextFile.js';
import { writeSecureTempTextFileSync as sourceWriteSecureTempTextFileSync } from './runtime/tempTextFile.js';
import type { FileSystemService as SourceFileSystemService } from './services/io.js';
import {
    canonicalizePath as sourceCanonicalizePath,
    canonicalizePathSync as sourceCanonicalizePathSync,
    expandHomePath as sourceExpandHomePath,
    resolveHomeDirFromEnvironment as sourceResolveHomeDirFromEnvironment,
    resolveConfiguredPath as sourceResolveConfiguredPath,
} from './sessions/fileStores/paths.js';

describe('EU-3 async and filesystem package-local projections', () => {
    it('projects the exact realm-safe async implementations without the retired timeout service', () => {
        expect(Object.keys(asyncProjection).sort()).toEqual([
            'createCoalescedScheduler',
            'raceWithTimeout',
            'sleep',
            'sleepWithSignal',
        ]);
        expect(asyncProjection.createCoalescedScheduler).toBe(sourceCreateCoalescedScheduler);
        expect(asyncProjection.raceWithTimeout).toBe(timeoutSource.raceWithTimeout);
        expect(asyncProjection.sleep).toBe(timeoutSource.sleep);
        expect(asyncProjection.sleepWithSignal).toBe(timeoutSource.sleepWithSignal);

        expectTypeOf<ProjectedCoalescedScheduler>().toEqualTypeOf<SourceCoalescedScheduler>();
        expectTypeOf<ProjectedRaceWithTimeoutResult<string>>()
            .toEqualTypeOf<SourceRaceWithTimeoutResult<string>>();

/* @sdk-negative-type-case:src-asyncFsProjections-test-ts-1:VGhlIGRvcm1hbnQgdGltZW91dCBzZXJ2aWNlIGlzIG5vdCBwYXJ0IG9mIHRoZSBmaW5hbCBgL2FzeW5jYCBwcm9qZWN0aW9uLg:dHlwZSBSZXRpcmVkVGltZW91dEJ1ZGdldCA9IGltcG9ydCgnLi9hc3luYy5qcycpLlRpbWVvdXRCdWRnZXRWMTs */
type RetiredTimeoutBudget = never; /* @sdk-negative-type-case-end */
/* @sdk-negative-type-case:src-asyncFsProjections-test-ts-2:VGhlIGRvcm1hbnQgdGltZW91dCBzZXJ2aWNlIGlzIG5vdCBwYXJ0IG9mIHRoZSBmaW5hbCBgL2FzeW5jYCBwcm9qZWN0aW9uLg:dHlwZSBSZXRpcmVkVGltZW91dFNlcnZpY2UgPSBpbXBvcnQoJy4vYXN5bmMuanMnKS5UaW1lb3V0UnVudGltZVNlcnZpY2VWMTs */
type RetiredTimeoutService = never; /* @sdk-negative-type-case-end */
    });

    it('projects only the approved daemon filesystem identities', () => {
        expect(Object.keys(fsProjection).sort()).toEqual([
            'canonicalizePath',
            'canonicalizePathSync',
            'expandHomePath',
            'resolveConfiguredPath',
            'resolveHomeDirFromEnvironment',
            'withExclusiveFileLock',
            'writeAtomicJsonFile',
            'writeAtomicTextFile',
            'writeSecureTempTextFileSync',
        ]);
        expect(fsProjection.canonicalizePath).toBe(sourceCanonicalizePath);
        expect(fsProjection.canonicalizePathSync).toBe(sourceCanonicalizePathSync);
        expect(fsProjection.expandHomePath).toBe(sourceExpandHomePath);
        expect(fsProjection.resolveHomeDirFromEnvironment).toBe(sourceResolveHomeDirFromEnvironment);
        expect(fsProjection.resolveConfiguredPath).toBe(sourceResolveConfiguredPath);
        expect(fsProjection.writeSecureTempTextFileSync).toBe(sourceWriteSecureTempTextFileSync);

        expectTypeOf<FsAtomicWriteJsonInput>().toEqualTypeOf<FsAtomicWriteJsonInputV1>();
        expectTypeOf<FsAtomicWriteTextInput>().toEqualTypeOf<FsAtomicWriteTextInputV1>();
        expectTypeOf<FileSystemService>()
            .toEqualTypeOf<SourceFileSystemService>();
        expectTypeOf<RuntimeFileSystemService>()
            .toEqualTypeOf<SourceFileSystemService>();
        expectTypeOf<SecureTempTextFileInput>().toEqualTypeOf<SecureTempTextFileInputV1>();

        const fsSource = readFileSync(new URL('./fs.ts', import.meta.url), 'utf8');
        expect(fsSource).toMatch(
            /export type \{\s*FileSystemService,?\s*\} from '\.\/services\/io\.js';/,
        );

/* @sdk-negative-type-case:src-asyncFsProjections-test-ts-3:VGhlIGRvcm1hbnQgZmlsZXN5c3RlbSBydW50aW1lIGlzIG5vdCBwYXJ0IG9mIHRoZSBmaW5hbCBgL2ZzYCBwcm9qZWN0aW9uLg:dHlwZSBSZXRpcmVkRnNSdW50aW1lU2VydmljZSA9IGltcG9ydCgnLi9mcy5qcycpLkZzUnVudGltZVNlcnZpY2VWMTs */
type RetiredFsRuntimeService = never; /* @sdk-negative-type-case-end */
    });
});
