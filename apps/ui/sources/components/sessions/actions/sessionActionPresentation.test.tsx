import { describe, expect, it } from 'vitest';

import { ACTION_IDS } from '@happier-dev/protocol';

import { t } from '@/text';
import { getTranslationValue } from '@/text/i18n';
import { SUPPORTED_LANGUAGE_CODES } from '@/text/_all';

import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_EDIT_TAGS_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_PIN_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_STOP_ID,
    SESSION_ACTION_TOOL_CALLS_TOGGLE_ID,
    SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID,
    SESSION_ACTION_UNARCHIVE_ID,
    SESSION_ACTION_UNPIN_ID,
} from './sessionActionIds';
import { getSessionActionMetadata } from './sessionActionMetadata';
import { createSessionActionDropdownItem, createSessionActionInfoItemProps, resolveSessionDeleteWarning } from './sessionActionPresentation';
import type { SessionActionTarget } from './sessionActionTypes';
import { SESSION_BULK_ACTION_IDS } from './sessionBulkActionTypes';

// Only the facts the tool-call rows read; the rest of the target is irrelevant to this presentation.
function toolCallsTarget(input: Readonly<{ bot: boolean; override: boolean | null }>): SessionActionTarget {
    return {
        session: { id: 's1', metadata: input.bot ? { path: '/p', bot: { kind: 'bot' } } : { path: '/p' } },
        toolCallsOverride: input.override,
    } as unknown as SessionActionTarget;
}

describe('session action presentation', () => {
    it('marks destructive Session operations so a menu can draw them in danger ink and place them last', () => {
        expect(createSessionActionDropdownItem({ actionId: SESSION_ACTION_ARCHIVE_ID, iconColor: '#000' })?.destructive).toBe(true);
        expect(createSessionActionDropdownItem({ actionId: SESSION_ACTION_RENAME_ID, iconColor: '#000' })?.destructive).toBeUndefined();
    });

    it('states where a Session\'s tool-call visibility comes from and offers Use default only over its own choice', () => {
        const item = (actionId: typeof SESSION_ACTION_TOOL_CALLS_TOGGLE_ID | typeof SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID,
            target: SessionActionTarget, accountShowToolCalls: boolean | null) =>
            createSessionActionDropdownItem({ actionId, target, accountShowToolCalls, iconColor: '#000' });

        const bot = toolCallsTarget({ bot: true, override: null });
        expect(item(SESSION_ACTION_TOOL_CALLS_TOGGLE_ID, bot, true)).toMatchObject({ checked: false, subtitle: t('bots.menu.toolsBotDefault') });
        expect(item(SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID, bot, true)).toMatchObject({ disabled: true });

        const ordinary = toolCallsTarget({ bot: false, override: null });
        expect(item(SESSION_ACTION_TOOL_CALLS_TOGGLE_ID, ordinary, null)).toMatchObject({ checked: true, subtitle: t('bots.menu.toolsAccountDefault') });
        expect(item(SESSION_ACTION_TOOL_CALLS_TOGGLE_ID, ordinary, false)).toMatchObject({ checked: false });

        const shownBot = toolCallsTarget({ bot: true, override: true });
        expect(item(SESSION_ACTION_TOOL_CALLS_TOGGLE_ID, shownBot, false)).toMatchObject({ checked: true, subtitle: t('bots.menu.toolsOnHere') });
        expect(item(SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID, shownBot, false)?.disabled).toBeUndefined();
        expect(item(SESSION_ACTION_TOOL_CALLS_TOGGLE_ID, toolCallsTarget({ bot: false, override: false }), true))
            .toMatchObject({ checked: false, subtitle: t('bots.menu.toolsOffHere') });
    });

    it('resolves tool visibility action labels without replacing the transcript group label in any locale', () => {
        for (const language of SUPPORTED_LANGUAGE_CODES) {
            expect(typeof getTranslationValue('session.toolCalls', language)).toBe('string');
            for (const actionId of [SESSION_ACTION_TOOL_CALLS_TOGGLE_ID, SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID]) {
                const metadata = getSessionActionMetadata(actionId);
                expect(metadata).not.toBeNull();
                const title = getTranslationValue(metadata!.titleKey, language);
                expect(typeof title).toBe('string');
                expect(title).not.toBe(metadata!.titleKey);
                if (language !== 'en') {
                    expect(title).not.toBe(getTranslationValue(metadata!.titleKey, 'en'));
                }
            }
        }
    });
    it('discloses deferred cleanup for an offline managed session without exposing its private path', () => {
        const input = {
            defaultWarning: 'delete session',
            offlineManagedWarning: 'cleanup waits for reconnect',
            machineOnline: false,
        };
        const metadata = { path: '/private/session-root', sessionDirectoryV1: { v: 1, kind: 'managed' } };
        const warning = resolveSessionDeleteWarning({ ...input, metadata });
        expect(warning).toBe('delete session\n\ncleanup waits for reconnect');
        expect(warning).not.toContain(metadata.path);
        expect(resolveSessionDeleteWarning({ ...input, metadata: {} })).toBe(input.defaultWarning);
        expect(resolveSessionDeleteWarning({ ...input, metadata, machineOnline: true })).toBe(input.defaultWarning);
    });
    it('uses unarchive-specific info copy', () => {
        const props = createSessionActionInfoItemProps({
            actionId: SESSION_ACTION_UNARCHIVE_ID,
        });

        expect(props?.title).toBe(t('sessionInfo.unarchiveSession'));
        expect(props?.subtitle).toBe(t('sessionInfo.unarchiveSessionSubtitle'));
    });

    it('uses one metadata source for shared single and bulk actions', () => {
        expect(getSessionActionMetadata(SESSION_BULK_ACTION_IDS.stop)).toBe(getSessionActionMetadata(SESSION_ACTION_STOP_ID));
        expect(getSessionActionMetadata(SESSION_BULK_ACTION_IDS.archive)).toBe(getSessionActionMetadata(SESSION_ACTION_ARCHIVE_ID));
        expect(getSessionActionMetadata(SESSION_BULK_ACTION_IDS.markRead)).toBe(getSessionActionMetadata(SESSION_ACTION_MARK_READ_ID));
    });

    it('keeps UI-local session action ids out of the protocol action namespace', () => {
        const protocolActionIds = new Set<string>(ACTION_IDS);
        const uiSessionActionIds = [
            SESSION_ACTION_MARK_READ_ID,
            SESSION_ACTION_MARK_UNREAD_ID,
            SESSION_ACTION_RENAME_ID,
            SESSION_ACTION_STOP_ID,
            SESSION_ACTION_ARCHIVE_ID,
            SESSION_ACTION_UNARCHIVE_ID,
            SESSION_ACTION_DELETE_ID,
            SESSION_ACTION_PIN_ID,
            SESSION_ACTION_UNPIN_ID,
            SESSION_ACTION_EDIT_TAGS_ID,
            SESSION_ACTION_MOVE_TO_FOLDER_ID,
            ...Object.values(SESSION_BULK_ACTION_IDS),
        ];

        expect(uiSessionActionIds.filter((id) => protocolActionIds.has(id))).toEqual([]);
    });
});
