import type { SetSessionPinRequest } from '@happier-dev/protocol/sessions/organization/mutations';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getStorage } from '@/sync/domains/state/storageStore';
import { normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';
import { resolveSessionAddressFromLocalState } from '@/sync/domains/session/resolveSessionAddressFromLocalState';

let execute: ReturnType<typeof createFrontDoorActionExecute> | null = null;

/** Personal organization intent crosses shared Action admission and the captured Account writer. */
export const sessionOrganizationActions = {
    setSection(sessionId: string, sectionId: string | null, options: Readonly<{
        serverId: string;
        expectedAccountId: string;
    }>) {
        const address = normalizeSessionAddress(options.serverId, sessionId);
        if (!address) return Promise.resolve({ ok: false as const, errorCode: 'session_not_selected', error: 'Session Home is unavailable or ambiguous' });
        execute ??= createFrontDoorActionExecute();
        return execute('session.section.set', { sessionId: address.sessionId, sectionId }, {
            surface: 'ui', serverId: address.serverId, expectedAccountId: options.expectedAccountId,
        });
    },
    /** Section definitions (create, rename/icon, remove) through the same Action admission as agents. */
    editSection(actionId: 'session.sections.create' | 'session.sections.update' | 'session.sections.delete',
        input: Readonly<Record<string, unknown>>, options: Readonly<{ serverId: string; expectedAccountId: string }>) {
        execute ??= createFrontDoorActionExecute();
        return execute(actionId, input, { surface: 'ui', serverId: options.serverId, expectedAccountId: options.expectedAccountId });
    },
    /** Archives a section's exact membership; each member keeps its own archive policy. */
    archiveSection(sectionId: string, options: Readonly<{ serverId: string; expectedAccountId: string }>) {
        execute ??= createFrontDoorActionExecute();
        return execute('session.sections.archive', { sectionId }, { surface: 'ui', serverId: options.serverId, expectedAccountId: options.expectedAccountId });
    },
    setPin(sessionId: string, pinned: boolean, options?: Readonly<{
        serverId?: string | null;
        surface?: SetSessionPinRequest['surface'];
        sortKey?: string | null;
    }>) {
        const address = options?.serverId === undefined
            ? resolveSessionAddressFromLocalState(getStorage().getState(), sessionId)
            : normalizeSessionAddress(options.serverId, sessionId);
        if (!address) return Promise.resolve({ ok: false as const, errorCode: 'session_not_selected', error: 'Session Home is unavailable or ambiguous' });
        execute ??= createFrontDoorActionExecute();
        return execute('session.organization.pin.set', {
            sessionId: address.sessionId, pinned,
            ...(options?.surface === undefined ? {} : { surface: options.surface }),
            ...(options?.sortKey === undefined ? {} : { sortKey: options.sortKey }),
        }, { surface: 'ui', serverId: address.serverId });
    },
};
