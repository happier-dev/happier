import { describe, expect, it } from 'vitest';
import { formatPermissionRequestSummary } from './permissionSummary';

describe('formatPermissionRequestSummary', () => {
    it('prefers permission title over any inferred shell/file summary', () => {
        const summary = formatPermissionRequestSummary({
            toolName: 'bash',
            toolInput: {
                command: 'echo hello',
                permission: { title: 'Use of this tool requires approval' },
            },
        });
        expect(summary).toBe('Use of this tool requires approval');
    });

    it('prefers permission title when present', () => {
        const summary = formatPermissionRequestSummary({
            toolName: 'unknown',
            toolInput: { permission: { title: 'Access file outside working directory: /etc/hosts' } },
        });
        expect(summary).toBe('Access file outside working directory: /etc/hosts');
    });

    it('summarizes shell command permissions', () => {
        const summary = formatPermissionRequestSummary({
            toolName: 'bash',
            toolInput: { command: 'echo hello' },
        });
        expect(summary).toBe('Run: echo hello');
    });

    it('summarizes file read permissions', () => {
        const summary = formatPermissionRequestSummary({
            toolName: 'read',
            toolInput: { filepath: '/etc/hosts' },
        });
        expect(summary).toBe('Read: /etc/hosts');
    });

    it('summarizes file read permissions from locations[]', () => {
        const summary = formatPermissionRequestSummary({
            toolName: 'read',
            toolInput: { locations: [{ path: '/etc/hosts' }] },
        });
        expect(summary).toBe('Read: /etc/hosts');
    });

    it('summarizes file write permissions from items[]', () => {
        const summary = formatPermissionRequestSummary({
            toolName: 'write',
            toolInput: { items: [{ path: '/tmp/a.txt', type: 'diff' }] },
        });
        expect(summary).toBe('Write: /tmp/a.txt');
    });

    it('summarizes nested ACP paths from toolCall.content[]', () => {
        const summary = formatPermissionRequestSummary({
            toolName: 'read',
            toolInput: { toolCall: { content: [{ path: '/srv/data.txt' }] } },
        });
        expect(summary).toBe('Read: /srv/data.txt');
    });

    it('falls back to details-unavailable when there are no usable fields', () => {
        const summary = formatPermissionRequestSummary({
            toolName: 'custom_tool',
            toolInput: null,
        });
        expect(summary).toBe('Permission required: custom_tool (details unavailable)');
    });

    it('falls back to generic summary when object input has unrecognized keys', () => {
        const summary = formatPermissionRequestSummary({
            toolName: 'custom_tool',
            toolInput: { foo: 'bar' },
        });
        expect(summary).toBe('Permission required: custom_tool');
    });
});
