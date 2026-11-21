import { describe, expect, it } from 'vitest';
import { omitBlankSoftwareInputs, readSoftwareFirewallRules, readSoftwareInputFields } from './StoreSoftwareInputs';

// The shape a package-by-name recipe declares: one manager choice, then that manager's own fields.
const hints = {
    fields: [
        { path: 'package.manager', title: 'Package manager', widget: 'select' as const, required: true,
            options: [{ value: 'apt', label: 'APT' }, { value: 'brew', label: 'Homebrew' }] },
        { path: 'package.apt.name', title: 'Package name', widget: 'text' as const, required: true,
            visibleWhen: { op: 'eq' as const, path: 'package.manager', value: 'apt' } },
        { path: 'package.apt.version', title: 'Exact version', widget: 'text' as const,
            visibleWhen: { op: 'eq' as const, path: 'package.manager', value: 'apt' } },
        { path: 'package.brew.kind', title: 'Homebrew package kind', widget: 'select' as const, required: true,
            visibleWhen: { op: 'eq' as const, path: 'package.manager', value: 'brew' },
            options: [{ value: 'formula', label: 'Formula' }, { value: 'cask', label: 'Cask' }] },
    ],
};

describe('Software recipe input drafts', () => {
    it('waits on the first required field still empty and shows only the chosen manager’s fields', () => {
        expect(readSoftwareInputFields(hints, {})).toMatchObject({ missing: 'Package manager' });
        expect(readSoftwareInputFields(hints, {}).fields.map(field => field.path)).toEqual(['package.manager']);
        const apt = { package: { manager: 'apt', apt: { name: '  ' } } };
        expect(readSoftwareInputFields(hints, apt)).toMatchObject({ missing: 'Package name' });
        expect(readSoftwareInputFields(hints, apt).fields.map(field => field.path)).toEqual(
            ['package.manager', 'package.apt.name', 'package.apt.version']);
        expect(readSoftwareInputFields(hints, { package: { manager: 'brew' } }).missing).toBe('Homebrew package kind');
        expect(readSoftwareInputFields(hints, { package: { manager: 'apt', apt: { name: 'google-chrome-stable' } } }).missing).toBeNull();
    });

    it('hands the owner absent values, never empty text, for boxes left blank', () => {
        expect(omitBlankSoftwareInputs({ package: { manager: 'apt', apt: { name: 'curl', version: ' ' }, dnf: { name: '' } } }))
            .toEqual({ package: { manager: 'apt', apt: { name: 'curl' } } });
        expect(omitBlankSoftwareInputs({ package: { manager: '', apt: { name: '' } } })).toBeUndefined();
    });

    it('retains an explicitly entered empty JSON object as a deliberate recipe input', () => {
        expect(omitBlankSoftwareInputs({ daemonConfig: {} })).toEqual({ daemonConfig: {} });
        expect(readSoftwareInputFields({ fields: [{ path: 'daemonConfig', title: 'Docker settings', widget: 'json', required: true }] },
            { daemonConfig: {} }).missing).toBeNull();
    });
});

describe('readSoftwareFirewallRules', () => {
    const guided = { steps: [{ id: 'owned-firewall', kind: 'firewall' as const, rules: { kind: 'openPorts' as const, path: 'open' } }] };

    it('shows the exact table the review applies for the ports typed, and nothing until they resolve', () => {
        expect(readSoftwareFirewallRules(guided, { open: { tcp: ['443'] } })).toContain('meta nfproto ipv4 tcp dport 443 accept');
        expect(readSoftwareFirewallRules(guided, { open: { tcp: ['443x'] } })).toBeNull();
        expect(readSoftwareFirewallRules(guided, {})).toBeNull();
    });

    it('has nothing to preview for a recipe whose rules are not computed from ports', () => {
        const raw = { steps: [{ id: 'owned-firewall', kind: 'firewall' as const, rules: { kind: 'input' as const, path: 'rules' } }] };
        expect(readSoftwareFirewallRules(raw, { rules: 'table inet happier {}' })).toBeNull();
        expect(readSoftwareFirewallRules(undefined, {})).toBeNull();
    });
});
