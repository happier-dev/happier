/**
 * Map a machine's `metadata.platform` string to the path-domain
 * `PathTargetPlatform` enum so the path picker can drive separator semantics
 * from the machine identity (NEVER from `navigator.platform`).
 *
 * Inputs are deliberately defensive: machine metadata is wire-driven and the
 * `platform` field is `z.string()`, so we accept any case + common aliases.
 */

import type { PathTargetPlatform } from './browseSegments';

export function machineMetadataPlatformToTarget(platform: string | null | undefined): PathTargetPlatform {
    if (typeof platform !== 'string') return 'auto';
    const normalized = platform.trim().toLowerCase();
    if (normalized.length === 0) return 'auto';
    if (normalized.startsWith('win')) return 'windows';
    if (
        normalized === 'darwin'
        || normalized === 'mac'
        || normalized === 'macos'
        || normalized === 'osx'
        || normalized === 'linux'
        || normalized === 'freebsd'
        || normalized === 'openbsd'
        || normalized === 'netbsd'
        || normalized === 'sunos'
        || normalized === 'unix'
    ) {
        return 'unix';
    }
    return 'auto';
}
