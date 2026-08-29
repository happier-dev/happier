import { describe, expect, it } from 'vitest';

import {
    parseCapabilitiesDescribeResponse,
    parseCapabilitiesDetectResponse,
    parseCapabilitiesInvokeResponse,
} from './capabilitiesProtocol';

describe('capabilitiesProtocol', () => {
    it('parses describe responses and filters invalid descriptors and checklist entries', () => {
        const result = parseCapabilitiesDescribeResponse({
            protocolVersion: 1,
            capabilities: [
                {
                    id: 'cli.codex',
                    kind: 'cli',
                    title: 'Codex CLI',
                    methods: {
                        install: { title: 'Install' },
                        broken: 'invalid',
                    },
                },
                {
                    id: 'bad-id',
                    kind: 'cli',
                },
            ],
            checklists: {
                default: [
                    { id: 'cli.codex', params: { source: 'system' } },
                    { id: 'bad-id' },
                    null,
                ],
            },
        });

        expect(result).toEqual({
            protocolVersion: 1,
            capabilities: [
                {
                    id: 'cli.codex',
                    kind: 'cli',
                    title: 'Codex CLI',
                    methods: {
                        install: { title: 'Install' },
                    },
                },
            ],
            checklists: {
                default: [
                    { id: 'cli.codex', params: { source: 'system' } },
                ],
            },
        });
    });

    it('retains qualified installed-Agent capability identities through describe and detect', () => {
        const qualifiedId = 'cli.com.acme.agent/assistant';
        expect(parseCapabilitiesDescribeResponse({
            protocolVersion: 1,
            capabilities: [{ id: qualifiedId, kind: 'cli' }],
            checklists: { default: [{ id: qualifiedId }] },
        })).toEqual({
            protocolVersion: 1,
            capabilities: [{ id: qualifiedId, kind: 'cli' }],
            checklists: { default: [{ id: qualifiedId }] },
        });
        expect(parseCapabilitiesDetectResponse({
            protocolVersion: 1,
            results: {
                [qualifiedId]: { ok: true, checkedAt: 1, data: { available: true } },
            },
        })).toEqual({
            protocolVersion: 1,
            results: {
                [qualifiedId]: { ok: true, checkedAt: 1, data: { available: true } },
            },
        });
    });

    it('parses detect responses and ignores invalid capability ids or malformed results', () => {
        const result = parseCapabilitiesDetectResponse({
            protocolVersion: 1,
            results: {
                'cli.codex': {
                    ok: true,
                    checkedAt: 123,
                    data: { available: true },
                },
                'tool.shell': {
                    ok: false,
                    checkedAt: 456,
                    error: { message: 'missing', code: 'missing_cli' },
                },
                'bad id': {
                    ok: true,
                    checkedAt: 789,
                },
                'dep.tmux': {
                    ok: false,
                    checkedAt: 'bad',
                    error: { message: 'wrong' },
                },
            },
        });

        expect(result).toEqual({
            protocolVersion: 1,
            results: {
                'cli.codex': {
                    ok: true,
                    checkedAt: 123,
                    data: { available: true },
                },
                'tool.shell': {
                    ok: false,
                    checkedAt: 456,
                    error: { message: 'missing', code: 'missing_cli' },
                },
            },
        });
    });

    it('parses invoke responses for success and failure envelopes', () => {
        expect(
            parseCapabilitiesInvokeResponse({
                ok: true,
                result: { installed: true },
            }),
        ).toEqual({
            ok: true,
            result: { installed: true },
        });

        expect(
            parseCapabilitiesInvokeResponse({
                ok: false,
                error: { message: 'install failed', code: 'spawn_failed' },
                logPath: '/tmp/install.log',
            }),
        ).toEqual({
            ok: false,
            error: { message: 'install failed', code: 'spawn_failed' },
            logPath: '/tmp/install.log',
        });
    });
});
