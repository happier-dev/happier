import { describe, expect, it } from 'vitest';

import {
    readSessionOwnerMetadataView,
    resolveSessionOwnerMetadataViewRead,
} from './readSessionOwnerMetadataView';

const METADATA = Object.freeze({ path: '/Users/tester/project', host: 'tester.local' });

describe('resolveSessionOwnerMetadataViewRead', () => {
    it('separates a not-yet-projected owner view from a layout this build cannot read', () => {
        expect(resolveSessionOwnerMetadataViewRead({
            metadataLayoutVersion: 1,
            metadata: METADATA,
            ownerMetadataView: null,
        })).toEqual({ kind: 'not_projected' });

        expect(resolveSessionOwnerMetadataViewRead({
            metadataLayoutVersion: 2,
            metadata: METADATA,
            ownerMetadataView: METADATA,
        })).toEqual({ kind: 'unsupported_layout_version' });
    });

    it('reads the layout-appropriate owner view when one is available', () => {
        expect(resolveSessionOwnerMetadataViewRead({
            metadataLayoutVersion: 1,
            metadata: METADATA,
            ownerMetadataView: METADATA,
        })).toEqual({ kind: 'available', metadata: METADATA });

        expect(resolveSessionOwnerMetadataViewRead({
            metadata: METADATA,
        })).toEqual({ kind: 'available', metadata: METADATA });

        expect(resolveSessionOwnerMetadataViewRead({
            metadataLayoutVersion: 0,
            metadata: null,
        })).toEqual({ kind: 'not_projected' });
    });

    it('keeps the existing view projection collapsing every unreadable cause to null', () => {
        expect(readSessionOwnerMetadataView({
            metadataLayoutVersion: 1,
            metadata: METADATA,
            ownerMetadataView: METADATA,
        })).toBe(METADATA);
        expect(readSessionOwnerMetadataView({
            metadataLayoutVersion: 1,
            metadata: METADATA,
            ownerMetadataView: null,
        })).toBeNull();
        expect(readSessionOwnerMetadataView({
            metadataLayoutVersion: 2,
            metadata: METADATA,
            ownerMetadataView: METADATA,
        })).toBeNull();
    });
});
