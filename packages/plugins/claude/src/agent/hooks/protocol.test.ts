import { describe, expect, it } from 'vitest';

import {
    buildDefaultPermissionHookResponse,
    readPermissionHookEventName,
} from './protocol.js';

describe('Claude hook protocol', () => {
    it('defaults permission hooks to PermissionRequest', () => {
        expect(readPermissionHookEventName({})).toBe('PermissionRequest');
        expect(buildDefaultPermissionHookResponse()).toMatchObject({
            continue: true,
            suppressOutput: true,
            hookSpecificOutput: { hookEventName: 'PermissionRequest' },
        });
    });

    it('preserves PreToolUse as the permission response shape selector', () => {
        expect(readPermissionHookEventName({ hook_event_name: 'PreToolUse' })).toBe('PreToolUse');
        expect(buildDefaultPermissionHookResponse({ hookEventName: 'PreToolUse' })).toMatchObject({
            hookSpecificOutput: { hookEventName: 'PreToolUse' },
        });
    });
});

