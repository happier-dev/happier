import { describe, expect, it } from 'vitest';

import { AGENT_INPUT_CONTROL_REGISTRY } from './agentInputControlRegistry';
import { resolveAgentInputControlLines } from './resolveAgentInputControlLines';

describe('resolveAgentInputControlLines', () => {
    it('keeps primary and secondary controls on separate lines in wrap layout', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'wrap',
            controlIds: ['engine', 'permission', 'stop', 'files', 'reviewComments', 'machine', 'path', 'resume'],
        });

        expect(lines.primary).toEqual(['engine', 'permission', 'stop', 'files', 'reviewComments']);
        expect(lines.secondary).toEqual(['machine', 'path', 'resume']);
        expect(lines.collapsed).toEqual([]);
    });

    it('keeps primary and secondary controls on separate lines in scroll layout', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'scroll',
            controlIds: ['engine', 'permission', 'stop', 'files', 'reviewComments', 'machine', 'path', 'resume'],
        });

        expect(lines.primary).toEqual(['engine', 'permission', 'stop', 'files', 'reviewComments']);
        expect(lines.secondary).toEqual(['machine', 'path', 'resume']);
        expect(lines.collapsed).toEqual([]);
    });

    it('moves all controls into the collapsed action menu in collapsed layout', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'collapsed',
            controlIds: ['engine', 'permission', 'stop', 'files', 'reviewComments', 'machine', 'path', 'resume'],
        });

        expect(lines.primary).toEqual([]);
        expect(lines.secondary).toEqual([]);
        expect(lines.collapsed).toEqual(['engine', 'permission', 'stop', 'files', 'reviewComments', 'machine', 'path', 'resume']);
    });

    it('keeps connected services on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'wrap',
            controlIds: ['engine', 'connectedServices', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine', 'connectedServices']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('keeps storage on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'wrap',
            controlIds: ['engine', 'storage', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine', 'storage']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('keeps linked files on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'wrap',
            controlIds: ['engine', 'linkedFiles', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine', 'linkedFiles']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('keeps shortcuts on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'wrap',
            controlIds: ['engine', 'shortcuts', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine', 'shortcuts']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('keeps mcp on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'wrap',
            controlIds: ['engine', 'mcp', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine', 'mcp']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('keeps automation on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'wrap',
            controlIds: ['engine', 'automation', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine', 'automation']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('keeps stop pinned in the early primary order defined by the canonical registry', () => {
        expect(AGENT_INPUT_CONTROL_REGISTRY.map((control) => control.id)).toEqual([
            'engine',
            'mode',
            'permission',
            'actionMenu',
            'profile',
            'env',
            'server',
            'connectedServices',
            'mcp',
            'checkout',
            'automation',
            'stop',
            'recipient',
            'delivery',
            'attachments',
            'linkedFiles',
            'files',
            'reviewComments',
            'storage',
            'windowsRemoteSessionMode',
            'providerOption',
            'shortcuts',
            'machine',
            'path',
            'resume',
        ]);
    });
});
