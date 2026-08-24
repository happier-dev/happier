import { describe, it, expect } from 'vitest';
import {
    compareVersions,
    getVersionSupportState,
    isVersionSupported,
    parseVersion,
    MINIMUM_CLI_VERSION,
    MINIMUM_CLI_BACKEND_TARGET_SPAWN_VERSION,
    MINIMUM_CLI_SESSION_USER_MESSAGE_RPC_VERSION,
} from './versionUtils';

describe('versionUtils', () => {
    describe('getVersionSupportState', () => {
        it('distinguishes opaque development identities from versions proven too old', () => {
            expect(getVersionSupportState('0.2.10-dev.abcdef123', MINIMUM_CLI_VERSION)).toBe('unknown');
            expect(getVersionSupportState('0.0.9', MINIMUM_CLI_VERSION)).toBe('unsupported');
            expect(getVersionSupportState('0.1.0', MINIMUM_CLI_VERSION)).toBe('supported');
        });
    });

    describe('compareVersions', () => {
        it('should correctly compare versions', () => {
            expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
            expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
            expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
            expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
            expect(compareVersions('1.9.9', '2.0.0')).toBe(-1);
        });

        it('rejects unsupported prerelease channels', () => {
            expect(() => compareVersions('0.10.0-1', '0.10.0')).toThrow();
            expect(() => compareVersions('0.10.0-beta', '0.10.0')).toThrow();
            expect(() => compareVersions('0.10.1-1', '0.10.0')).toThrow();
        });

        it('orders stable builds after prerelease channels on the same base version', () => {
            expect(compareVersions('0.1.0', '0.1.0-dev.0')).toBe(1);
            expect(compareVersions('0.1.0-dev.1775063171.91734', '0.1.0-dev.0')).toBe(1);
            expect(compareVersions('0.2.0-preview.1775367533.1', '0.2.0')).toBe(-1);
        });

        it('should handle versions with different segment counts', () => {
            expect(compareVersions('1.0', '1.0.0')).toBe(0);
            expect(compareVersions('1', '1.0.0')).toBe(0);
            expect(compareVersions('1.1', '1.0.5')).toBe(1);
        });
    });

    describe('isVersionSupported', () => {
        it('should check if version meets minimum requirement', () => {
            expect(isVersionSupported('0.10.0', '0.10.0')).toBe(true);
            expect(isVersionSupported('0.10.1', '0.10.0')).toBe(true);
            expect(isVersionSupported('0.9.9', '0.10.0')).toBe(false);
            expect(isVersionSupported('1.0.0', '0.10.0')).toBe(true);
        });

        it('should handle undefined version', () => {
            expect(isVersionSupported(undefined, '0.10.0')).toBe(false);
        });

        it('should use default minimum version', () => {
            // Default minimum version should allow the current dev CLI baseline (0.1.0).
            expect(isVersionSupported('0.1.0')).toBe(true);
            expect(isVersionSupported('0.0.9')).toBe(false);
        });

        it('returns false for invalid version input', () => {
            expect(isVersionSupported('invalid', MINIMUM_CLI_VERSION)).toBe(false);
        });

        it('accepts compatible 0.1.0 dev builds for modern spawn and runtime rpc gates', () => {
            const devVersion = '0.1.0-dev.1775063171.91734';
            expect(isVersionSupported(devVersion, MINIMUM_CLI_BACKEND_TARGET_SPAWN_VERSION)).toBe(true);
            expect(isVersionSupported(devVersion, MINIMUM_CLI_SESSION_USER_MESSAGE_RPC_VERSION)).toBe(true);
            expect(isVersionSupported('0.1.0', MINIMUM_CLI_BACKEND_TARGET_SPAWN_VERSION)).toBe(true);
            expect(isVersionSupported('0.1.0', MINIMUM_CLI_SESSION_USER_MESSAGE_RPC_VERSION)).toBe(true);
        });
    });

    describe('parseVersion', () => {
        it('should parse valid version strings', () => {
            expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
            expect(parseVersion('0.10.0')).toEqual({ major: 0, minor: 10, patch: 0 });
            expect(parseVersion('0.10.0-1')).toEqual({ major: 0, minor: 10, patch: 0 });
        });

        it('should return null for invalid versions', () => {
            expect(parseVersion('invalid')).toBe(null);
            expect(parseVersion('')).toBe(null);
            expect(parseVersion('1.a.3')).toBe(null);
            expect(parseVersion('1.2')).toBe(null);
            expect(parseVersion('1.2.NaN')).toBe(null);
        });
    });
});
