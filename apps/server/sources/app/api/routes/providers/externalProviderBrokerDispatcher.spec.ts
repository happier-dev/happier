import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    type PeerTcpTunnelRelayEnvelope,
} from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/utils/logging/log';
import { TeamCredentialTestActionOutputV1Schema } from '@happier-dev/protocol/teams/credentials/actionsV1';

import {
    createExternalProviderBrokerDispatcher,
    mapProviderBrokerApplicationFailure,
} from './externalProviderBrokerDispatcher';

describe('external Provider broker dispatcher', () => {
    afterEach(() => vi.restoreAllMocks());
    it('maps only trusted broker denial codes to the closed public error vocabulary', () => {
        expect(mapProviderBrokerApplicationFailure(403, {
            'x-happier-provider-broker-error-code': 'team_credential_usage_limit',
            'x-happier-provider-broker-limit-metric': 'total_tokens',
            'x-happier-provider-broker-limit-remaining': '0',
            'x-happier-provider-broker-limit-resets-at': '2026-09-15T00:00:00.000Z',
        })).toEqual({ error: 'team_credential_usage_limit', retryAtMs: Date.parse('2026-09-15T00:00:00.000Z') });
        expect(mapProviderBrokerApplicationFailure(403, {
            'x-happier-provider-broker-error-code': 'cost_limit_unavailable',
        })).toEqual({ error: 'cost_limit_unavailable' });
        expect(mapProviderBrokerApplicationFailure(403, {
            'x-happier-provider-broker-error-code': 'resource_changed',
        })).toEqual({ error: 'resource_unavailable' });
        expect(mapProviderBrokerApplicationFailure(499, {
            'x-happier-provider-broker-error-code': 'request_cancelled',
        })).toEqual({ error: 'request_cancelled' });
        expect(mapProviderBrokerApplicationFailure(403, {
            'x-happier-provider-broker-error-code': 'secret-provider-detail',
        })).toEqual({ error: 'policy_denied' });
    });

    async function dispatchWithUpstreamResponse(response: Uint8Array, options: Readonly<{
        enabled?: boolean; env?: NodeJS.ProcessEnv; relaySocketId?: string; closeOnOpen?: boolean;
        denyOnOpen?: boolean; cancellation?: AbortController;
    }> = {}) {
        let receive: ((envelope: PeerTcpTunnelRelayEnvelope) => void) | undefined;
        let responseSent = false;
        const relaySocketId = options.relaySocketId ?? 'relay-socket-1';
        const machineId = 'broker-machine-1';
        const accountId = 'custodian-account-1';
        let transportCloseCount = 0;
        const dispatch = createExternalProviderBrokerDispatcher({
            enabled: () => options.enabled ?? true,
            env: options.env ?? {
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_KEY_ID: 'test-key',
                HAPPIER_PEER_MEDIATION_ROUTE_GRANT_SIGNING_PRIVATE_KEY: Buffer.alloc(32, 7).toString('base64url'),
            },
            createRelayTransport: () => ({
                relaySocketId,
                subscribe(handler) { receive = handler; return () => {}; },
                close() { transportCloseCount += 1; },
                send(_event, envelope) {
                    if (options.denyOnOpen && envelope.v === 1 && envelope.frame.kind === 'open') {
                        // The registered Home relay sends its terminal refusal
                        // to the owner with the original envelope participants.
                        receive?.({ ...envelope, frame: { v: 1, kind: 'abort',
                            tunnelId: envelope.frame.open.tunnelId, reasonCode: 'route_unavailable' } });
                        return;
                    }
                    if (options.denyOnOpen) return;
                    if (options.closeOnOpen && envelope.v === 1 && envelope.frame.kind === 'open') {
                        receive?.({ ...envelope, sender: { kind: 'machine', machineId },
                            recipient: { kind: 'user', socketId: relaySocketId },
                            frame: { v: 1, kind: 'close', tunnelId: envelope.frame.open.tunnelId,
                                halfClose: false, reasonCode: 'completed' } });
                        return;
                    }
                    if (envelope.v !== 2 || responseSent) return;
                    const decoded = decodePeerTcpTunnelBinaryFrameV2({
                        frame: envelope.frame,
                        maxHeaderBytes: 64 * 1024,
                        maxPayloadBytes: 64 * 1024,
                    });
                    if (!decoded.ok || decoded.header.kind !== 'data') return;
                    responseSent = true;
                    receive?.({
                        v: 2,
                        scopeUserId: accountId,
                        sender: { kind: 'machine', machineId },
                        recipient: { kind: 'user', socketId: relaySocketId },
                        encoding: 'binary_frame_v2',
                        frame: encodePeerTcpTunnelBinaryFrameV2({
                            header: {
                                version: 2,
                                kind: 'data',
                                tunnelId: decoded.header.tunnelId,
                                substreamId: decoded.header.substreamId,
                                direction: 'daemon_to_client',
                                sequence: 0,
                                payloadLength: response.byteLength,
                            },
                            payload: response,
                        }),
                    });
                    receive?.({
                        v: 2,
                        scopeUserId: accountId,
                        sender: { kind: 'machine', machineId },
                        recipient: { kind: 'user', socketId: relaySocketId },
                        encoding: 'binary_frame_v2',
                        frame: encodePeerTcpTunnelBinaryFrameV2({ header: {
                            version: 2, kind: 'close', tunnelId: decoded.header.tunnelId,
                            substreamId: decoded.header.substreamId, direction: 'daemon_to_client',
                            halfClose: true, reasonCode: 'upstream_eof', payloadLength: 0,
                        } }),
                    });
                },
            }),
        });

        const cancellation = options.cancellation ?? new AbortController();
        const removeAbortListener = vi.spyOn(cancellation.signal, 'removeEventListener');
        const result = await dispatch({
            target: { custodianAccountId: accountId, brokerMachineId: machineId, operationId: null, brokerPlacementFingerprint: 'a'.repeat(64) },
            signal: cancellation.signal,
            request: {
                v: 1,
                requestId: 'request-1',
                teamId: 'team-1',
                resourceId: 'resource-1',
                caller: {
                    kind: 'external_api_key',
                    keyId: '550e8400-e29b-41d4-a716-446655440000',
                    assignedAccountId: 'account-1',
                    assignedTeamMembershipId: 'membership-1',
                },
                route: 'models',
                method: 'GET',
                pathAndQuery: '/v1/models',
                bodyBase64: null,
            },
        });

        return { result, removeAbortListener, transportCloseCount: () => transportCloseCount };
    }

    it('keeps transport cancellation valid for the Team credential Test consumer', async () => {
        const cancellation = new AbortController();
        cancellation.abort();
        const { result } = await dispatchWithUpstreamResponse(httpResponse('unused'), { cancellation });
        expect(result).toMatchObject({ ok: false, error: 'request_cancelled',
            failureDetail: { stage: 'relay_admission' } });
        if (result.ok) throw new Error('Expected cancellation');
        expect(TeamCredentialTestActionOutputV1Schema.parse({
            result: 'needs_attention', code: result.failureDetail?.code ?? result.error,
            failureDetail: result.failureDetail, readiness: { kind: 'source_unavailable' },
        })).toMatchObject({ code: 'request_cancelled', failureDetail: { stage: 'relay_admission' } });
    });

    it('preserves the broker request-size refusal through the relay without classifying an upstream outage', async () => {
        const response = new TextEncoder().encode('HTTP/1.1 413 Payload Too Large\r\nx-happier-provider-broker-error-code: request_too_large\r\nContent-Length: 0\r\n\r\n');
        const { result } = await dispatchWithUpstreamResponse(response);
        expect(result).toEqual({ ok: false, error: 'invalid_request',
            failureDetail: { code: 'request_too_large', stage: 'application_response', httpStatus: 413 } });
    });

    function httpResponse(body: string) {
        return new TextEncoder().encode(
            `HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
        );
    }

    it('settles a Home relay admission refusal without waiting for caller cancellation', async () => {
        const cancellation = new AbortController();
        let settled = false;
        const pending = dispatchWithUpstreamResponse(httpResponse('unused'), { denyOnOpen: true, cancellation })
            .finally(() => { settled = true; });
        const terminal = pending.catch(() => undefined);
        try {
            await vi.waitFor(() => expect(settled).toBe(true));
            await expect(pending).resolves.toMatchObject({ result: { ok: false, error: 'broker_unavailable' } });
        } finally {
            cancellation.abort();
            await terminal;
        }
    });

    it.each([
        [{ enabled: false }, 'feature', 'disabled'],
        [{ env: {} }, 'signing', 'missing_key_id'],
        [{ relaySocketId: '' }, 'relay_authorization', 'invalid_scope'],
        [{ closeOnOpen: true }, 'request_write', 'write_failed'],
    ] as const)('records a content-free stage when carrier setup fails: %j', async (options, stage, code) => {
        const diagnostics = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const { result } = await dispatchWithUpstreamResponse(httpResponse('ok'), options);
        expect(result).toEqual({ ok: false, error: 'broker_unavailable', failureDetail: { code: 'broker_unavailable', stage } });
        expect(diagnostics).toHaveBeenCalledWith({ module: 'provider-broker-carrier', stage, code });
    });

    it('records the trusted update-required refusal without response content', async () => {
        const code = 'update_required';
        const diagnostics = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const { result } = await dispatchWithUpstreamResponse(new TextEncoder().encode(
            `HTTP/1.1 403 Forbidden\r\nX-Happier-Provider-Broker-Error-Code: ${code}\r\nX-Private: private payload\r\n\r\nprivate body`,
        ));
        expect(result).toMatchObject({ ok: false, error: 'broker_unavailable' });
        expect(result).toMatchObject({ reason: 'incompatible' });
        expect(diagnostics).toHaveBeenCalledWith({ module: 'provider-broker-carrier', stage: 'application_response', code, statusCode: 403 });
        expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private');
    });

    // The relay coalesces whatever it has: a small control response and a legal
    // 32 KiB body can both arrive in the dispatcher's first chunk. The header
    // budget bounds headers, so neither may be refused as an oversized header.
    it.each([128, 32 * 1024])('accepts the admitted broker machine binary response coalesced with a %i-byte body', async (size) => {
        const body = 'o'.repeat(size);
        const { result, removeAbortListener, transportCloseCount } = await dispatchWithUpstreamResponse(httpResponse(body));
        expect(result).toMatchObject({ ok: true, statusCode: 200 });
        if (!result.ok) return;
        const chunks: Uint8Array[] = [];
        for await (const chunk of result.body) chunks.push(chunk);
        expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')).toBe(body);
        expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
        expect(transportCloseCount()).toBe(1);
    });

    it('still refuses a header segment larger than the header budget', async () => {
        const diagnostics = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const { result } = await dispatchWithUpstreamResponse(
            new TextEncoder().encode(`HTTP/1.1 200 OK\r\nX-Oversized: ${'h'.repeat(24 * 1024)}`),
        );
        expect(result).toEqual({ ok: false, error: 'upstream_unavailable', failureDetail: { stage: 'response_headers' } });
        expect(diagnostics).toHaveBeenCalledWith({ module: 'provider-broker-carrier', stage: 'response_headers', code: 'headers_too_large' });
    });

    it.each([
        ['', 'response_incomplete'],
        ['HTTP/1.1 200 OK\r\nContent-Length: 0', 'response_incomplete'],
        ['invalid status\r\n\r\n', 'status_invalid'],
    ])('diagnoses a closed or malformed application response: %j', async (wire, code) => {
        const diagnostics = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const { result } = await dispatchWithUpstreamResponse(new TextEncoder().encode(wire));
        expect(result).toEqual({ ok: false, error: 'upstream_unavailable', failureDetail: { stage: 'response_headers' } });
        expect(diagnostics).toHaveBeenCalledWith({ module: 'provider-broker-carrier', stage: 'response_headers', code });
    });

    it.each(['resource_changed', 'source_unavailable', 'model_not_allowed', 'connected_service_credential_reconnect_required', 'private-unknown'])('preserves only a closed application refusal: %s', async code => {
        const diagnostics = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const { result } = await dispatchWithUpstreamResponse(new TextEncoder().encode(
            `HTTP/1.1 403 Forbidden\r\nX-Happier-Provider-Broker-Error-Code: ${code}\r\n\r\nprivate body`,
        ));
        expect(result).toMatchObject({ ok: false });
        expect(result).toMatchObject({ failureDetail: { stage: 'application_response', httpStatus: 403 } });
        if (code === 'private-unknown') expect(result).not.toHaveProperty('failureDetail.code');
        else expect(result).toHaveProperty('failureDetail.code', code);
        if (code === 'source_unavailable') expect(result).toHaveProperty('error', 'upstream_unavailable');
        expect(JSON.stringify(result)).not.toContain('private');
        if (code === 'connected_service_credential_reconnect_required') expect(result).toHaveProperty('error', code);
        expect(diagnostics).toHaveBeenCalledWith({ module: 'provider-broker-carrier', stage: 'application_response',
            code: code === 'private-unknown' ? 'application_refusal_unclassified' : code, statusCode: 403 });
        expect(JSON.stringify(diagnostics.mock.calls)).not.toContain('private');
    });
});
