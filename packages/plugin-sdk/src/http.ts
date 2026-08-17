/** @moduleRealm daemon */
/** @realm any */
import type { JsonValue } from './identity.js';
import type { HttpMethod } from './services/io.js';

/** Declared installation-wide policy scope for one request interceptor. */
export type RequestInterceptorContribution = Readonly<{
    id: string;
    origins: readonly string[];
    methods?: readonly HttpMethod[];
    priority?: number;
    availability?: unknown;
    metadata?: Readonly<Record<string, JsonValue>>;
}>;
export type {
    PluginInterceptedRequest,
    PluginInterceptorRegistrationApi,
    PluginInterceptorResult,
    PluginRequestInterceptor,
} from './activation.js';
/** @realm any */
export type { HttpMethod } from './services/io.js';
export type {
    HttpService,
    PluginFetchCredentialBinding,
    PluginWebSocketClose,
    PluginWebSocketConnection,
    PluginWebSocketHeader,
    PluginWebSocketMessage,
    PluginWebSocketOpenInput,
} from './services/io.js';
