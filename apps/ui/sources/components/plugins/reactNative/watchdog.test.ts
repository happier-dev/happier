import { describe, expect, it } from 'vitest';

import { createPluginReactNativeWatchdog } from './watchdog';

const digestA = `sha256:${'a'.repeat(64)}` as const;
const digestB = `sha256:${'b'.repeat(64)}` as const;

describe('plugin React Native local watchdog', () => {
    it('deduplicates repeated failures into one containment fact per digest', () => {
        const watchdog = createPluginReactNativeWatchdog();

        watchdog.recordFailure({ artifactDigest: digestA, failure: 'render_error' });
        watchdog.recordFailure({ artifactDigest: digestA, failure: 'render_error' });

        expect(watchdog.readFailure({ artifactDigest: digestA })).toBe('render_error');
    });

    it('Retry clears only the requested digest and a new digest starts uncontained', () => {
        const watchdog = createPluginReactNativeWatchdog();
        watchdog.recordFailure({ artifactDigest: digestA, failure: 'render_error' });
        watchdog.recordFailure({ artifactDigest: digestB, failure: 'load_error' });

        watchdog.clear({ artifactDigest: digestA });

        expect(watchdog.readFailure({ artifactDigest: digestA })).toBeNull();
        expect(watchdog.readFailure({ artifactDigest: digestB })).toBe('load_error');
        expect(watchdog.readFailure({
            artifactDigest: `sha256:${'c'.repeat(64)}`,
        })).toBeNull();
    });

    it('does not restore crash authority into a fresh watchdog instance', () => {
        const first = createPluginReactNativeWatchdog();
        first.recordFailure({ artifactDigest: digestA, failure: 'render_error' });

        const fresh = createPluginReactNativeWatchdog();

        expect(first.readFailure({ artifactDigest: digestA })).toBe('render_error');
        expect(fresh.readFailure({ artifactDigest: digestA })).toBeNull();
    });
});
