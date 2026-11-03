import { PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceInvocationOptionsV1, PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';
import { TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';

import { TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1, TriageReadSourceSessionLinksResultV1Schema, normalizeTriageSourceSessionLinksCoverageV1 } from '../actions/sessionLinksProtocol.js';

export const TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1 = 'session-links-v1';
const relationAction = { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1 } as const;

function sessionInput(options: PluginDynamicResourceInvocationOptionsV1) {
    if (options.context.kind !== 'session') throw new PluginError({ code: 'invalid_request', message: 'Session links require a mounted Session.' });
    return { v: 1, sessionId: SessionIdSchema.parse(options.context.sessionId) } as const;
}

/** The Action remains the sole source/corpus admission and paging owner. */
export const TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME: PluginDynamicResourceRuntime = {
    async read(options) {
        const input = sessionInput(options);
        const envelope = await options.readAction(relationAction, input, { signal: options.signal });
        if (!envelope.ok) throw new PluginError({ code: envelope.errorCode, message: envelope.error });
        return JSON.stringify(normalizeTriageSourceSessionLinksCoverageV1(TriageReadSourceSessionLinksResultV1Schema.parse(envelope.result)));
    },
    async observe(invalidate, options) {
        const input = sessionInput(options);
        const controller = new AbortController();
        let observation: Disposable | undefined;
        let cleanup: Promise<void> | undefined;
        const notify = () => { if (!controller.signal.aborted && !options.signal.aborted) invalidate(); };
        const fence = () => {
            controller.abort();
            options.signal.removeEventListener('abort', onAbort);
        };
        const dispose = (): Promise<void> => {
            fence();
            if (cleanup === undefined) {
                const handle = observation;
                observation = undefined;
                cleanup = Promise.resolve().then(() => handle?.dispose());
            }
            return cleanup;
        };
        const onAbort = () => {
            fence();
            // Event listeners have no awaiting caller. Explicit disposal still
            // receives the same cleanup rejection through the retained promise.
            if (observation !== undefined) void dispose().catch(() => {});
        };
        if (options.signal.aborted) fence();
        else options.signal.addEventListener('abort', onAbort, { once: true });
        if (!controller.signal.aborted) {
            try {
                observation = await options.observeAction(relationAction, input, notify, { signal: controller.signal });
                if (controller.signal.aborted || options.signal.aborted) await dispose();
            } catch (error) {
                await dispose();
                throw error;
            }
        }
        return { dispose };
    },
};
