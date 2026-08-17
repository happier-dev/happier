import { PluginError } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { openTriageEntryDetails } from './openEntryDetails.js';

/**
 * View details (`core/COMPOSER.md` §2.1).
 *
 * It opens ONE thing: the qualified Triage app page, through the generic
 * qualified-destination navigation owner, carrying the strict Triage launch
 * input. It is not the picker's other action: it attaches nothing, removes
 * nothing and cannot touch a draft, which is why it takes no composer at all.
 */

const SOURCE = Object.freeze({ pluginId: 'happier.scm.forge.github', localId: 'github' });
const OTHER_SOURCE = Object.freeze({ pluginId: 'happier.scm.forge.gitlab', localId: 'gitlab' });
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const ENTRY_REF = Object.freeze({
    source: SOURCE,
    kindId: 'pull-request',
    collisionScope: 'example/repository',
    entryId: '42',
});
const SOURCE_INSTANCE = Object.freeze({ source: SOURCE, sourceInstanceId: INSTANCE_ID });

type OpenCall = Readonly<{ view: unknown; input: unknown; options: unknown }>;

function createHost(behavior?: () => Promise<void>) {
    const calls: OpenCall[] = [];
    return {
        calls,
        hostApi: {
            openSurface: async (view: unknown, input?: unknown, options?: unknown) => {
                calls.push({ view, input, options });
                if (behavior) await behavior();
            },
        } as never,
    };
}

describe('opening the Triage entry detail from a Composer mount', () => {
    it('opens the one qualified Triage app page at its root with the strict input', async () => {
        const host = createHost();

        const outcome = await openTriageEntryDetails({
            hostApi: host.hostApi,
            entryRef: ENTRY_REF,
            sourceInstance: SOURCE_INSTANCE,
        });

        expect(outcome).toEqual({ kind: 'opened' });
        expect(host.calls).toEqual([{
            view: { pluginId: 'happier.triage', localId: 'triage' },
            input: {
                v: 1,
                kind: 'entryDetail',
                entryRef: ENTRY_REF,
                sourceInstance: SOURCE_INSTANCE,
            },
            // The page root, not a Triage-local route: the destination's own
            // selection reducer replaces this with the canonical entry encoding.
            options: { subPath: '' },
        }]);
    });

    it('refuses a selection its own parser rejects, before navigating anywhere', async () => {
        const host = createHost();

        const outcome = await openTriageEntryDetails({
            hostApi: host.hostApi,
            entryRef: ENTRY_REF,
            sourceInstance: { source: OTHER_SOURCE, sourceInstanceId: INSTANCE_ID },
        });

        // The strict input is admitted by the SAME parser the destination uses.
        // Navigating first and letting the page refuse would leave the user on a
        // detail page that cannot say what it is showing.
        expect(outcome).toEqual({ kind: 'refused', reason: 'invalidSelection' });
        expect(host.calls).toEqual([]);
    });

    it('reports a refused destination as unavailable, carrying the host code', async () => {
        const host = createHost(async () => {
            throw new PluginError({ code: 'plugin_surface_open_destination_unknown' });
        });

        const outcome = await openTriageEntryDetails({
            hostApi: host.hostApi,
            entryRef: ENTRY_REF,
            sourceInstance: SOURCE_INSTANCE,
        });

        // Fail-closed navigation is correct behaviour, not a Triage bug to work
        // around: there is no second opener to try, and the invoked control has
        // to be able to say why nothing happened.
        expect(outcome).toEqual({
            kind: 'refused',
            reason: 'unavailable',
            code: 'plugin_surface_open_destination_unknown',
        });
    });

    it('reports a cancelled open as cancelled rather than as a failure', async () => {
        const controller = new AbortController();
        const host = createHost(async () => {
            controller.abort();
            throw new DOMException('Aborted', 'AbortError');
        });

        const outcome = await openTriageEntryDetails({
            hostApi: host.hostApi,
            entryRef: ENTRY_REF,
            sourceInstance: SOURCE_INSTANCE,
            signal: controller.signal,
        });

        // A dismissed picker aborts its own work. Announcing that as a failure
        // would put an error on a control the user deliberately walked away
        // from — and the contract says a cancelled open mutates nothing.
        expect(outcome).toEqual({ kind: 'cancelled' });
    });

    it('does not navigate at all once the caller has already been retired', async () => {
        const controller = new AbortController();
        controller.abort();
        const host = createHost();

        const outcome = await openTriageEntryDetails({
            hostApi: host.hostApi,
            entryRef: ENTRY_REF,
            sourceInstance: SOURCE_INSTANCE,
            signal: controller.signal,
        });

        expect(outcome).toEqual({ kind: 'cancelled' });
        expect(host.calls).toEqual([]);
    });
});
