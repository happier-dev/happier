import { isPluginError, PluginError, readPluginErrorRequestIdV1, type Disposable } from '@happier-dev/plugin-sdk';
import { SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1, SessionPullRequestBindingResultV1Schema, type SessionPullRequestBindingResultV1 } from '@happier-dev/channels-protocol/v1';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import type { PluginDynamicResourceInvocationOptionsV1, PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';
import { readTriageSessionSetEnvelopeV1, TriageListInvocationErrorV1Schema, TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1 } from '@happier-dev/triage-protocol/v1';

import { TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1, TriageReadSourceSessionLinksResultV1Schema, normalizeTriageSourceSessionLinksCoverageV1 } from '../actions/sessionLinksProtocol.js';

export const TRIAGE_SESSION_LINKS_RESOURCE_LOCAL_ID_V1 = 'session-links-v1';
const relationAction = { pluginId: TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1, localId: TRIAGE_READ_SOURCE_SESSION_LINKS_ACTION_LOCAL_ID_V1 } as const;
const channelsAction = { pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_RELATIONS_ACTION_ID_V1 } as const;

export type SessionPullRequestRelations = Extract<SessionPullRequestBindingResultV1, { kind: 'relations' }>;

function channelsInput(sessionId: string) {
    return { kind: 'readRelations' as const, credentialRef: null, sessionIds: [sessionId] };
}

function channelsUnavailable(code: string) {
    return code === 'plugin_action_not_found' || code === 'plugin_surface_action_projection_unavailable'
        || code === 'channels_provider_contribution_unavailable';
}

async function readChannelsRelations(options: PluginDynamicResourceInvocationOptionsV1, sessionId: string): Promise<SessionPullRequestRelations | undefined> {
    const failed = (code: string, requestId?: string): SessionPullRequestRelations => ({ kind: 'relations', links: [],
        failures: [{ sessionId, code, ...(requestId === undefined ? {} : { requestId }) }] });
    try {
        const envelope = await options.readAction(channelsAction, channelsInput(sessionId), { signal: options.signal });
        if (!envelope.ok) return channelsUnavailable(envelope.errorCode) ? undefined
            : failed(envelope.errorCode, envelope.requestId ?? readPluginErrorRequestIdV1(envelope));
        const { result, refusals } = readTriageSessionSetEnvelopeV1(envelope.result);
        const refusal = refusals.get(sessionId);
        if (refusal !== undefined) return failed(refusal);
        const parsed = SessionPullRequestBindingResultV1Schema.safeParse(result);
        if (!parsed.success || parsed.data.kind !== 'relations' || parsed.data.links.some(link => link.sessionId !== sessionId)) {
            return failed('sessionLinksInvalidResult');
        }
        return parsed.data.links.length === 0 && !parsed.data.failures?.length ? undefined : parsed.data;
    } catch (error) {
        options.signal.throwIfAborted();
        const code = isPluginError(error) ? error.code : 'sessionLinksReadFailed';
        return channelsUnavailable(code) ? undefined : failed(code, readPluginErrorRequestIdV1(error));
    }
}

/** Both Resource consumers share the private envelope and the source Action's existing schema. */
export function decodeTriageSessionLinksResource(bytes: Uint8Array) {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected Session links.');
    const { channels, sourceReadError, ...source } = value as { channels?: unknown; sourceReadError?: unknown };
    const native = channels === undefined ? undefined : SessionPullRequestBindingResultV1Schema.parse(channels);
    if (native !== undefined && native.kind !== 'relations') throw new Error('Expected Session PR relations.');
    return { ...normalizeTriageSourceSessionLinksCoverageV1(TriageReadSourceSessionLinksResultV1Schema.parse(source)),
        ...(native === undefined ? {} : { channels: native }),
        ...(sourceReadError === undefined ? {} : { sourceReadError: TriageListInvocationErrorV1Schema.parse(sourceReadError) }) };
}

function sessionInput(options: PluginDynamicResourceInvocationOptionsV1) {
    if (options.context.kind !== 'session') throw new PluginError({ code: 'invalid_request', message: 'Session links require a mounted Session.' });
    return { v: 1, sessionId: SessionIdSchema.parse(options.context.sessionId) } as const;
}

/** Triage owns source coverage and Channels owns native PR membership for this exact Session. */
export const TRIAGE_SESSION_LINKS_RESOURCE_RUNTIME: PluginDynamicResourceRuntime = {
    async read(options) {
        const input = sessionInput(options);
        const channels = readChannelsRelations(options, input.sessionId);
        const source = options.readAction(relationAction, input, { signal: options.signal }).then(envelope => {
            if (!envelope.ok) throw new PluginError({ code: envelope.errorCode, message: envelope.error,
                details: envelope.details === undefined ? undefined : projectNativeJsonValueForTransport(envelope.details) });
            return normalizeTriageSourceSessionLinksCoverageV1(TriageReadSourceSessionLinksResultV1Schema.parse(envelope.result));
        });
        const [scoped, native] = await Promise.allSettled([source, channels]);
        if (native.status === 'rejected') throw native.reason;
        if (scoped.status === 'rejected') {
            if (!native.value?.links.length) throw scoped.reason;
            const failure = scoped.reason;
            const requestId = readPluginErrorRequestIdV1(failure);
            const diagnostic = TriageListInvocationErrorV1Schema.safeParse({
                code: isPluginError(failure) ? failure.code : 'sessionLinksReadFailed',
                ...(isPluginError(failure) ? { retryable: failure.retryable } : {}),
                ...(requestId === undefined ? {} : { requestId }),
            });
            return JSON.stringify({ kind: 'partial', links: [], lanes: [], channels: native.value,
                ...(diagnostic.success ? { sourceReadError: diagnostic.data } : {}) });
        }
        return JSON.stringify({ ...scoped.value, ...(native.value === undefined ? {} : { channels: native.value }) });
    },
    async observe(invalidate, options) {
        const input = sessionInput(options);
        const controller = new AbortController();
        const observations: Disposable[] = [];
        let cleanup: Promise<void> | undefined;
        const notify = () => { if (!controller.signal.aborted && !options.signal.aborted) invalidate(); };
        const fence = () => {
            controller.abort();
            options.signal.removeEventListener('abort', onAbort);
        };
        const dispose = (): Promise<void> => {
            fence();
            if (cleanup === undefined) {
                cleanup = Promise.all(observations.splice(0).map(handle => Promise.resolve().then(() => handle.dispose()))).then(() => {});
            }
            return cleanup;
        };
        const onAbort = () => {
            fence();
            // Event listeners have no awaiting caller. Explicit disposal still
            // receives the same cleanup rejection through the retained promise.
            if (observations.length > 0) void dispose().catch(() => {});
        };
        if (options.signal.aborted) fence();
        else options.signal.addEventListener('abort', onAbort, { once: true });
        if (!controller.signal.aborted) {
            try {
                const observe = async (action: Parameters<typeof options.observeAction>[0], value: Parameters<typeof options.observeAction>[1]) => {
                    const handle = await options.observeAction(action, value, notify, { signal: controller.signal });
                    if (controller.signal.aborted) await handle.dispose();
                    else observations.push(handle);
                };
                await observe(relationAction, input);
                if (!controller.signal.aborted) {
                    try { await observe(channelsAction, channelsInput(input.sessionId)); }
                    catch (error) { if (!isPluginError(error) || !channelsUnavailable(error.code)) throw error; }
                }
                if (controller.signal.aborted || options.signal.aborted) await dispose();
            } catch (error) {
                await dispose();
                throw error;
            }
        }
        return { dispose };
    },
};
