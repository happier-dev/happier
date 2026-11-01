import { PluginError } from '../errors.js';
import type { HttpRequest } from './contracts.js';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

// Nested HTTP boundaries share one immutable ingress snapshot.
const admittedRequests = new WeakSet<object>();

function invalidRequest(): never {
    throw new PluginError({ code: 'invalid_request', message: 'HTTP request is invalid' });
}

export function snapshotPluginHttpRequest(input: HttpRequest): HttpRequest {
    if (input !== null && typeof input === 'object' && admittedRequests.has(input)) return input;
    try {
        if (input === null || typeof input !== 'object') return invalidRequest();
        const { url, method, headers, body, credentialBinding, redirect, timeoutMs, responseBody, observeTlsPeer } = input;
        if (responseBody !== undefined && responseBody !== 'buffer' && responseBody !== 'discard') return invalidRequest();
        if (observeTlsPeer !== undefined && observeTlsPeer !== true) return invalidRequest();
        if (body !== undefined && !(body instanceof Uint8Array)) return invalidRequest();
        const request: HttpRequest = Object.freeze({
            url, redirect,
            ...(method === undefined ? {} : { method }),
            ...(headers === undefined ? {} : { headers: Object.freeze({ ...headers }) }),
            ...(credentialBinding === undefined ? {} : { credentialBinding: Object.freeze(
                credentialBinding.kind === 'connectedAccountPurpose'
                    ? { ...credentialBinding, headerNames: Object.freeze([...credentialBinding.headerNames]) }
                    : { ...credentialBinding,
                        provider: Object.freeze({ ...credentialBinding.provider }),
                        parameters: normalizeStrictJsonValue(credentialBinding.parameters) as typeof credentialBinding.parameters },
            ) }),
            ...(body === undefined ? {} : { body: new Uint8Array(body) }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(responseBody === undefined ? {} : { responseBody }),
            ...(observeTlsPeer === undefined ? {} : { observeTlsPeer }),
        });
        admittedRequests.add(request);
        return request;
    } catch {
        return invalidRequest();
    }
}
