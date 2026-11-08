import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

/** Preserve parent Session services while identifying the Run that owns this native conversation. */
export function withRunScopedSessionContext(
    context: AgentSessionRuntimeContext,
    executionRunId: string,
): AgentSessionRuntimeContext {
    const hooks = context.session.services.sessionHooks;
    return Object.freeze({
        ...context,
        session: Object.freeze({
            ...context.session,
            executionRunId,
            services: Object.freeze({
                ...context.session.services,
                sessionHooks: Object.freeze({
                    ...hooks,
                    // Child runtimes share Session identity, never its retained hook endpoint or files.
                    startServer: (request: Parameters<typeof hooks.startServer>[0]) =>
                        hooks.startServer({ ...request, lifetime: 'invocation' }),
                    createPluginDir: (request: Parameters<typeof hooks.createPluginDir>[0]) =>
                        hooks.createPluginDir({ ...request, lifetime: 'invocation' }),
                }),
            }),
        }),
    });
}
