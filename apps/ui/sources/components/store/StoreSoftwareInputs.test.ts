import { describe, expect, it } from 'vitest';
import { omitBlankSoftwareInputs, readSoftwareInputFields } from './StoreSoftwareInputs';

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
});
