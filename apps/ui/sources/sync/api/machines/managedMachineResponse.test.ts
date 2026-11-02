import { describe, expect, it } from 'vitest';
import { projectMachineProvisionerSelectionV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import { readManagedMachineActionOutputV1 } from './managedMachineResponse';

const read = (value: unknown) => readManagedMachineActionOutputV1('machines.provisioners.options', value);
const launchSchema = { type: 'object' as const, properties: { cpu: { type: 'integer' as const } }, required: ['cpu'], additionalProperties: false };

describe('CD31 development controller response transition', () => {
    it('retains scalar singleton launches and native facts without manufacturing object choices', () => {
        const retention = { supportedIntents: ['delete'] };
        const nativeFacts = { image: { id: 'linux', title: 'Linux' } };
        const result = read({ choices: [{ id: 'guest', title: 'Reviewed guest', launch: 'native-token', retention, nativeFacts }] });
        expect(result).toMatchObject({ success: true, data: { base: { launch: 'native-token' }, dimensions: {
            size: [{ id: 'guest', title: 'Reviewed guest', assignments: [], retention, nativeFacts }],
        } } });
        if (!result.success) throw new Error('Legacy result not admitted');
        expect(projectMachineProvisionerSelectionV1({ options: result.data, selection: { size: 'guest' }, launchSchema: { type: 'string' } }))
            .toMatchObject({ kind: 'ready', launch: 'native-token', retention, nativeFacts });
    });
    it('preserves a sole exact Devcontainer effect review without turning it into per-option metadata', () => {
        const effectReview = { kind: 'devcontainer', reviewedEffectDigest: 'a'.repeat(64), effects: [] };
        const launch = { reviewedEffectDigest: effectReview.reviewedEffectDigest };
        expect(read({ choices: [{ id: 'reviewed', title: 'Reviewed child', launch, effectReview }] }))
            .toMatchObject({ success: true, data: { base: { launch, effectReview }, dimensions: { size: [{ assignments: [] }] } } });
        expect(read({ choices: [{ id: 'a', title: 'A', launch, effectReview },
            { id: 'b', title: 'B', launch: { reviewedEffectDigest: 'b'.repeat(64) }, effectReview: { ...effectReview, reviewedEffectDigest: 'b'.repeat(64) } }] }))
            .toEqual({ success: false });
    });
    it('leaves unavailable and launch-less rows visible but cannot allocate them or invalid closed launches', () => {
        const result = read({ choices: [{ id: 'valid', title: 'Valid', launch: { cpu: 2 } },
            { id: 'closed', title: 'Closed', launch: { cpu: 4, extra: true } },
            { id: 'unavailable', title: 'Unavailable', launch: { cpu: 8 }, available: false },
            { id: 'missing', title: 'Missing' }] });
        if (!result.success) throw new Error('Legacy result not admitted');
        const project = (size: string) => projectMachineProvisionerSelectionV1({ options: result.data, selection: { size }, launchSchema });
        expect(project('valid')).toMatchObject({ kind: 'ready', launch: { cpu: 2 } });
        expect(project('closed').kind).toBe('invalid');
        expect(project('unavailable').kind).toBe('unavailable');
        expect(project('missing').kind).toBe('unavailable');
    });
    it('rejects unsupported roots and malformed/hybrid wire shapes rather than inventing correlated dimensions', () => {
        expect(read({ choices: [{ id: 'a', title: 'A', launch: 'a' }, { id: 'b', title: 'B', launch: 'b' }] })).toEqual({ success: false });
        expect(read({ choices: [{ id: 'a', title: 'A', launch: { 'literal.path': 1 } }, { id: 'b', title: 'B', launch: {} }] })).toEqual({ success: false });
        expect(read({ choices: [{ id: 'a', title: 'A', launch: {}, prices: [{ amount: 'bad' }] }] })).toEqual({ success: false });
        expect(read({ choices: [], dimensions: { size: [], image: [], location: [], network: [], duration: [] } })).toEqual({ success: false });
        expect(readManagedMachineActionOutputV1('machines.provisioners.check', { choices: [] })).toEqual({ success: false });
    });
});
