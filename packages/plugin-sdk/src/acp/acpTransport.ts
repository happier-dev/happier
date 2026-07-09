import type { AcpTimeoutsV1 } from './types.js';

export type AcpTransportLaunchInputV1 =
    | Readonly<{
        kind: 'agent-cli';
        agentId: string;
        args?: readonly string[];
        env?: Readonly<Record<string, string>>;
    }>
    | Readonly<{
        kind: 'executable';
        command: string;
        args?: readonly string[];
        env?: Readonly<Record<string, string>>;
    }>
    | Readonly<{
        kind: 'system-tool';
        toolId: string;
        purpose: string;
        preferredPath?: string | null;
        preferredCommand?: string | null;
        args?: readonly string[];
        env?: Readonly<Record<string, string>>;
    }>;

export type AcpTransportKindV1 = 'stdio' | 'ws' | 'tcp';

export type AcpWsUrlResolverContextV1 = Readonly<{
    sessionId: string;
}>;

export type AcpCustomTransportHandlerDecisionV1 =
    | 'pass'
    | 'suppress'
    | Readonly<{
        kind: 'replace';
        message: unknown;
    }>;

export type AcpCustomTransportHandlerSpecV1 = Readonly<{
    preDial?: (ctx: Readonly<{ sessionId: string; cwd: string }>) => Promise<void>;
    onMessage?: (
        message: unknown,
        ctx: Readonly<{ sessionId: string; phase: 'incoming' | 'outgoing' }>,
    ) => AcpCustomTransportHandlerDecisionV1 | Promise<AcpCustomTransportHandlerDecisionV1>;
}>;

export type AcpTransportSpecV1 =
    | Readonly<{
        kind: 'stdio';
        launch: AcpTransportLaunchInputV1;
        customHandler?: AcpCustomTransportHandlerSpecV1;
        timeouts?: AcpTimeoutsV1;
    }>
    | Readonly<{
        kind: 'ws';
        url: string | ((ctx: AcpWsUrlResolverContextV1) => string | Promise<string>);
        headers?: Readonly<Record<string, string>>;
        customHandler?: AcpCustomTransportHandlerSpecV1;
        timeouts?: AcpTimeoutsV1;
    }>
    | Readonly<{
        kind: 'tcp';
        host: string;
        port: number;
        customHandler?: AcpCustomTransportHandlerSpecV1;
        timeouts?: AcpTimeoutsV1;
    }>;
