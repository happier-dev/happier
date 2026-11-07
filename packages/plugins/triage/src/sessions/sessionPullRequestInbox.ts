import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginDynamicResourceInvocationOptionsV1, PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';
import {
    SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1,
    SessionPullRequestWatchInputV1Schema,
    SessionPullRequestWatchListResultV1Schema,
    resolveDistinctPullRequestLinksV1,
} from '@happier-dev/channels-protocol/v1';

import { TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1 } from './sessionPullRequestResourceId.js';

export const TRIAGE_SESSION_PULL_REQUEST_INBOX_RESOURCE_LOCAL_ID_V1 = 'session-pull-request-inbox-v1';
const watchAction = { pluginId: 'happier.channels', localId: SESSION_PULL_REQUEST_WATCH_ACTION_ID_V1 } as const;

function inputFor(options: PluginDynamicResourceInvocationOptionsV1) {
    if (options.context.kind !== 'surface') throw new PluginError({ code: 'invalid_request', message: 'Inbox requires a surface context.' });
    const launch = options.context.launchInput;
    const cursor = launch !== null && typeof launch === 'object' && !Array.isArray(launch) && 'cursor' in launch
        ? launch.cursor : undefined;
    if (cursor != null && typeof cursor !== 'string') throw new PluginError({ code: 'invalid_request', message: 'Inbox cursor must be a string.' });
    return SessionPullRequestWatchInputV1Schema.parse({ kind: 'list', ...(cursor == null ? {} : { cursor }) });
}

/** One lightweight page from the Watch metadata owner; native PR status stays in the demanded detail. */
export const TRIAGE_SESSION_PULL_REQUEST_INBOX_RESOURCE_RUNTIME: PluginDynamicResourceRuntime = {
    async read(options) {
        const envelope = await options.readAction(watchAction, inputFor(options), { signal: options.signal });
        if (!envelope.ok) throw new PluginError({ code: envelope.errorCode, message: envelope.error });
        const page = SessionPullRequestWatchListResultV1Schema.parse(envelope.result);
        if (page.kind === 'unavailable') return JSON.stringify({ kind: 'unavailable',
            reason: page.reason === 'sessionUnavailable' ? 'sourceUnavailable' : page.reason });
        return JSON.stringify({ kind: 'ready', nextCursor: page.nextCursor,
            rows: page.sessions.flatMap(({ session, bindings }) => {
                if (bindings.length === 0) return [];
                let latest: (typeof bindings)[number]['latestUpdate'] = null;
                for (const binding of bindings) {
                    if (binding.latestUpdate && (!latest || binding.latestUpdate.occurredAtMs > latest.occurredAtMs)) latest = binding.latestUpdate;
                }
                const controls = bindings.flatMap(binding => {
                    if (binding.watch.reason !== 'exhausted' || binding.watch.fixAttemptLimit === null) return [];
                    const identity = { sessionId: session.sessionId, bindingId: binding.bindingId, expectedRevision: binding.revision };
                    const pullRequest = `${binding.link.repository}#${binding.link.number}`;
                    return [
                        { id: `continue:${binding.bindingId}`, label: { key: 'plugins.triage.prWatch.continueMore',
                            fallback: 'Continue {count} more · {pullRequest}', params: { count: binding.watch.fixAttemptLimit, pullRequest } },
                            effect: { kind: 'action', invocation: { action: watchAction,
                                input: SessionPullRequestWatchInputV1Schema.parse({ kind: 'retryFix', ...identity }) } } },
                        { id: `stop:${binding.bindingId}`, label: { key: 'plugins.triage.prWatch.stopPullRequest',
                            fallback: 'Stop watching · {pullRequest}', params: { pullRequest } },
                            effect: { kind: 'action', invocation: { action: watchAction,
                                input: SessionPullRequestWatchInputV1Schema.parse({ kind: 'configure', ...identity,
                                    policy: { ...binding.watch.policy, mode: 'off' } }) } } },
                    ];
                });
                const links = resolveDistinctPullRequestLinksV1(bindings.map(binding => binding.link));
                // One Session row, with all links retained in its existing detail Resource.
                const landing = links.find(link => link.state === 'open');
                return [{ id: session.sessionId, session,
                    title: links.map(link => `${link.repository}#${link.number}`).join(', '),
                    ...(landing ? { landing: { number: landing.number, url: landing.url, state: landing.state,
                        ...(landing.observedAt === undefined ? {} : { observedAt: landing.observedAt }) } } : {}),
                    detail: latest?.summary ?? null,
                    ...(controls.length === 0 ? {} : { controls }),
                    detailResource: { pluginId: 'happier.triage', resourceId: TRIAGE_SESSION_PULL_REQUEST_STATUS_RESOURCE_LOCAL_ID_V1 } }];
            }),
        });
    },
    async observe(invalidate, options) {
        const controller = new AbortController();
        let observation: Awaited<ReturnType<typeof options.observeAction>> | undefined;
        let cleanup: Promise<void> | undefined;
        const dispose = () => {
            controller.abort();
            options.signal.removeEventListener('abort', onAbort);
            cleanup ??= Promise.resolve().then(() => observation?.dispose());
            return cleanup;
        };
        const onAbort = () => { if (observation) void dispose().catch(() => {}); else controller.abort(); };
        if (options.signal.aborted) controller.abort();
        else options.signal.addEventListener('abort', onAbort, { once: true });
        try {
            if (!controller.signal.aborted) {
                observation = await options.observeAction(watchAction, inputFor(options), () => {
                    if (!controller.signal.aborted && !options.signal.aborted) invalidate();
                }, { signal: controller.signal });
                if (controller.signal.aborted || options.signal.aborted) await dispose();
            }
            return { dispose };
        } catch (error) { await dispose(); throw error; }
    },
};
