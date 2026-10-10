import * as React from 'react';
import * as Clipboard from 'expo-clipboard';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue, WorkflowProgressEnvelopeV1, WorkflowResultContract } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { Modal, ModalProvider } from '@/modal';
import { WorkflowReviewCard, type WorkflowReviewCardProps } from './WorkflowReviewCard';

const envelopeHttp = vi.hoisted(() => ({
    createSessionDataKeyEnvelopeClient: vi.fn(),
    readSessionDataKeyEnvelopeCollectionPage: vi.fn(),
    prepareSessionDataKeyEnvelopesForScope: vi.fn(),
    prepareSessionDataKeyEnvelopesDetached: vi.fn(),
    createMembershipSessionDataKeyEnvelopeClient: vi.fn(),
    prepareMembershipHistoryEnvelopesForScope: vi.fn(),
    membershipHistoryPreparationScopeKey: vi.fn(),
    prepareMembershipHistoryEnvelopesDetached: vi.fn(),
}));
// Recipient-envelope HTTP is not part of review rendering; no Collaboration or key preparation is opened.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => envelopeHttp);
vi.mock('@/sync/api/teams/membershipSessionDataKeyEnvelopesApi', () => envelopeHttp);
afterEach(async () => {
    for (const request of Object.values(envelopeHttp)) expect(request).not.toHaveBeenCalled();
    await act(async () => Modal.hideAll());
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ renderCustomModals: true }).module;
});
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => {}) }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const contract: WorkflowResultContract = { kind: 'json', schema: { type: 'object', properties: {
    summary: { type: 'string', minLength: 1 }, approved: { type: 'boolean' },
}, required: ['summary', 'approved'] } };
function progress(overrides: Partial<WorkflowProgressEnvelopeV1> = {}): WorkflowProgressEnvelopeV1 {
    return { kind: 'happier.workflow-progress.v1', invocationPath: { blockId: 'review', scope: [] },
        blockKind: 'step', attempt: '0', logicalInvocationRecordId: 'review',
        result: { summary: 'Published', approved: false, retained: { exact: [1, 2] } }, ...overrides };
}
async function mount(extra: Partial<WorkflowReviewCardProps> = {}) {
    const onComplete = vi.fn(async () => {});
    let publish!: (value: WorkflowProgressEnvelopeV1, revision: string) => void;
    function Host() {
        const [draft, onChangeDraft] = React.useState<{ text: string; contentRevision: string }>();
        const [publication, setPublication] = React.useState({ progress: extra.progress ?? progress(), revision: extra.contentRevision ?? '7' });
        const [reading, onChangeReading] = React.useState(() => extra.reading
            ?? { value: publication.progress.result, revision: publication.revision });
        publish = (value, revision) => setPublication({ progress: value, revision });
        return <ModalProvider><WorkflowReviewCard contract={contract} waitForYou={false}
            draft={draft} onChangeDraft={onChangeDraft} reading={reading} onChangeReading={onChangeReading} onComplete={onComplete}
            testIDPrefix="review" {...extra} progress={publication.progress} contentRevision={publication.revision} /></ModalProvider>;
    }
    return { screen: await renderScreen(<Host />), onComplete,
        publish: async (value: WorkflowProgressEnvelopeV1, revision: string) => { await act(async () => publish(value, revision)); } };
}
async function changeText(screen: Awaited<ReturnType<typeof renderScreen>>, id: string, value: string) {
    await act(async () => { screen.changeTextByTestId(id, value); });
}

describe('WorkflowReviewCard', () => {
    it('retains fieldless Wait Continue while exact evidence is unconfirmed without treating edit access as revoked', async () => {
        const { screen, onComplete } = await mount({ waitForYou: true, contract: undefined,
            progress: progress({ blockKind: 'wait', result: undefined }), disabled: true });
        expect(screen.findHostByTestId('review-use')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('review-use');
        expect(onComplete).not.toHaveBeenCalled();
        expect(screen.findAllHostsByTestId('review-editor')).toHaveLength(0);
    });
    it('keeps the draft and exact reading until an explicit newer-value choice', async () => {
        const { screen, onComplete, publish } = await mount();
        await screen.pressByTestIdAsync('review-edit');
        await changeText(screen, 'review-field-summary', 'My edits');
        const editor = screen.findByTestId('review-field-summary');
        await publish(progress({ result: { summary: 'Newer', approved: true } }), '8');
        expect(screen.findByTestId('review-field-summary')?.props.value).toBe('My edits');
        expect(screen.findByTestId('review-field-summary')).toBe(editor);
        await screen.pressByTestIdAsync('review-keep-edits');
        await screen.pressByTestIdAsync('review-use');
        expect(onComplete).toHaveBeenLastCalledWith({ mode: 'use_result', expectedContentRevision: '7',
            value: { summary: 'My edits', approved: false, retained: { exact: [1, 2] } } });
        await publish(progress({ result: { summary: 'Latest', approved: true } }), '9');
        await screen.pressByTestIdAsync('review-use-newer');
        expect(screen.findByTestId('review-field-summary')).toBeNull();
        await screen.pressByTestIdAsync('review-use');
        expect(onComplete).toHaveBeenLastCalledWith({ mode: 'use_result', expectedContentRevision: '9' });
        expect(screen.getTextContent()).toContain('Latest');
    });
    it('preserves an invalid raw buffer when inspecting and keeping a newer result', async () => {
        const { screen, publish } = await mount({ contract: { kind: 'json', schema: { type: 'object', allOf: [{ required: ['nested'] }] } } });
        await screen.pressByTestIdAsync('review-edit');
        await changeText(screen, 'review-editor', '{ unfinished');
        await publish(progress({ result: { nested: 'new' } }), '8');
        expect(screen.findByTestId('review-editor')?.props.value).toBe('{ unfinished');
        await screen.pressByTestIdAsync('review-keep-edits');
        expect(screen.findByTestId('review-editor')?.props.value).toBe('{ unfinished');
        expect(screen.findByTestId('review-use')?.props.disabled).toBe(true);
    });
    it.each(['text', 'object', 'plan'] as const)('bounds a long %s preview and opens the exact full reading without adopting new bytes', async (kind) => {
        const long = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join('\n');
        const value: JsonValue = kind === 'text' ? long : kind === 'plan' ? { document: long, proposal: { name: 'Keep me' } } : { summary: long, approved: false };
        const { screen, publish, onComplete } = await mount({ progress: progress({ result: value }),
            contract: kind === 'text' ? { kind: 'text' } : { kind: 'json', schema: { type: 'object' } } });
        const preview = screen.findByTestId('review-preview-scroll');
        expect(preview).not.toBeNull();
        const maxHeight = preview?.props.style.maxHeight;
        expect(maxHeight).toBeGreaterThan(0);
        expect(maxHeight).toBeLessThan(200 * 20);
        const fades = () => screen.findByTestId('review-preview')?.findAll((node) => String(node.type) === 'LinearGradient');
        expect(fades()).toHaveLength(0);
        await act(async () => {
            preview?.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: maxHeight } } });
            preview?.props.onContentSizeChange(390, 4000);
        });
        expect(fades()).toHaveLength(1);
        await act(async () => preview?.props.onContentSizeChange(390, 120));
        expect(fades()).toHaveLength(0);
        await screen.pressByTestIdAsync('review-show-full');
        const full = screen.findByTestId('review-full-value');
        expect(full).not.toBeNull();
        expect(full?.findAll((node) => node.props.markdown === long || node.props.children === long).length).toBeGreaterThan(0);
        await screen.pressByTestIdAsync('review-full-copy');
        expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
        await publish(progress({ result: kind === 'text' ? 'Newer' : { document: 'Newer' } }), '8');
        expect(screen.findByTestId('review-full-value')).toBe(full);
        await screen.pressByTestIdAsync('review-use');
        expect(onComplete).toHaveBeenCalledWith({ mode: 'use_result', expectedContentRevision: '7' });
    });
    it('lets a read-only reviewer explicitly inspect newer publications without enabling decisions', async () => {
        const onDiscuss = vi.fn();
        const onEditPlan = vi.fn(async () => {});
        const onRunPlan = vi.fn(async () => {});
        const { screen, onComplete, publish } = await mount({ readOnly: true, onDiscuss, onEditPlan, onRunPlan });
        await screen.pressByTestIdAsync('review-show-full');
        const full = screen.findByTestId('review-full-value');
        const newer = { summary: 'Updated publication', approved: true, retained: { exact: [3, 4] } };
        await publish(progress({ result: newer }), '8');
        expect(screen.getTextContent()).toContain('Published');
        expect(screen.getTextContent()).not.toContain(newer.summary);
        await screen.pressByTestIdAsync('review-full-copy');
        expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(JSON.stringify(progress().result, null, 2));
        expect(screen.findByTestId('review-show-newer')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('review-show-newer');
        expect(screen.getTextContent()).toContain(newer.summary);
        expect(screen.findByTestId('review-newer')).toBeNull();
        // An already-open inspection stays on its selected bytes until opened again.
        expect(screen.findByTestId('review-full-value')).toBe(full);
        await screen.pressByTestIdAsync('review-full-copy');
        expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(JSON.stringify(progress().result, null, 2));
        await screen.pressByTestIdAsync('review-copy');
        expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(JSON.stringify(newer, null, 2));
        await screen.pressByTestIdAsync('review-show-full');
        await screen.pressByTestIdAsync('review-full-copy');
        expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(JSON.stringify(newer, null, 2));
        for (const action of ['use', 'edit', 'generate', 'discuss', 'plan-run', 'plan-edit']) {
            expect(screen.findByTestId(`review-${action}`)).toBeNull();
        }
        expect(onComplete).not.toHaveBeenCalled();
        expect(onDiscuss).not.toHaveBeenCalled();
        expect(onEditPlan).not.toHaveBeenCalled();
        expect(onRunPlan).not.toHaveBeenCalled();
    });
    it('uses the exact shown edited value while preserving fields outside the simple form', async () => {
        const { screen, onComplete } = await mount();
        await screen.pressByTestIdAsync('review-edit');
        await changeText(screen, 'review-field-summary', 'Human edit');
        await screen.pressByTestIdAsync('review-use');
        expect(onComplete).toHaveBeenCalledWith({ mode: 'use_result', expectedContentRevision: '7', value: {
            summary: 'Human edit', approved: false, retained: { exact: [1, 2] },
        } });
    });
    it('keeps local newer-publication choices usable after losing edit authority with a retained draft', async () => {
        const access = { readOnly: false, pending: false };
        const { screen, publish, onComplete } = await mount(access);
        await screen.pressByTestIdAsync('review-edit');
        await changeText(screen, 'review-field-summary', 'Retained local edits');
        access.readOnly = true;
        await publish(progress({ result: { summary: 'New readable publication', approved: true } }), '8');
        expect(screen.findByTestId('review-use')).toBeNull();
        expect(screen.findByTestId('review-field-summary')?.props.editable).toBe(false);
        expect(screen.findByTestId('review-keep-edits')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('review-keep-edits');
        expect(screen.findByTestId('review-field-summary')?.props.value).toBe('Retained local edits');
        expect(screen.findByTestId('review-newer')).toBeNull();
        access.pending = true;
        await publish(progress({ result: { summary: 'Latest readable publication', approved: true } }), '9');
        expect(screen.findByTestId('review-use-newer')?.props.disabled).toBe(true);
        expect(screen.findByTestId('review-keep-edits')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('review-use-newer');
        expect(screen.findByTestId('review-field-summary')?.props.value).toBe('Retained local edits');
        access.pending = false;
        await publish(progress({ result: { summary: 'Latest readable publication', approved: true } }), '9');
        expect(screen.findByTestId('review-use-newer')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('review-use-newer');
        expect(screen.findByTestId('review-field-summary')).toBeNull();
        expect(screen.getTextContent()).toContain('Latest readable publication');
        await screen.pressByTestIdAsync('review-show-full');
        expect(screen.findByTestId('review-full-value')).not.toBeNull();
        expect(screen.findByTestId('review-use')).toBeNull();
        expect(onComplete).not.toHaveBeenCalled();
    });
    it('keeps invalid edits visible and cannot use a value rejected by the canonical schema', async () => {
        const { screen, onComplete } = await mount();
        await screen.pressByTestIdAsync('review-edit');
        await changeText(screen, 'review-field-summary', '');
        expect(screen.findByTestId('review-use')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('review-use');
        expect(onComplete).not.toHaveBeenCalled();
        expect(screen.findByTestId('review-field-summary')?.props.value).toBe('');
    });
    it('pins the displayed draft revision and preserves it when a newer publication arrives', async () => {
        const onComplete = vi.fn(async () => {});
        const onChangeDraft = vi.fn();
        const draft = { text: JSON.stringify({ summary: 'Local edit', approved: true }), contentRevision: '7' };
        const screen = await renderScreen(<WorkflowReviewCard progress={progress({ result: { summary: 'Newer', approved: false } })}
            contract={contract} waitForYou={false} contentRevision="8" draft={draft}
            onChangeDraft={onChangeDraft} onComplete={onComplete} testIDPrefix="review" />);
        expect(screen.findByTestId('review-newer')).not.toBeNull();
        expect(screen.findByTestId('review-field-summary')?.props.value).toBe('Local edit');
        await changeText(screen, 'review-field-summary', 'Still local');
        expect(onChangeDraft).toHaveBeenLastCalledWith({ text: JSON.stringify({ summary: 'Still local', approved: true }, null, 2), contentRevision: '7' });
        await screen.pressByTestIdAsync('review-use');
        expect(onComplete).toHaveBeenCalledWith({ mode: 'use_result', expectedContentRevision: '7', value: { summary: 'Local edit', approved: true } });
    });
    it('does not call an unchanged publication a newer result or submit a stale read token', async () => {
        const onComplete = vi.fn(async () => {});
        const value = { summary: 'Published', approved: false };
        const screen = await renderScreen(<WorkflowReviewCard progress={progress({ result: { approved: false, summary: 'Published' } })}
            contract={contract} waitForYou={false} contentRevision="8" draft={undefined}
            reading={{ value, revision: '7' }} onChangeDraft={() => {}} onComplete={onComplete} testIDPrefix="review" />);
        expect(screen.findAllHostsByTestId('review-newer')).toHaveLength(0);
        await screen.pressByTestIdAsync('review-use');
        expect(onComplete).toHaveBeenCalledWith({ mode: 'use_result', expectedContentRevision: '8' });
    });
    it('cancels edits back to stored bytes and uses the stored result without rewriting it', async () => {
        const { screen, onComplete } = await mount();
        await screen.pressByTestIdAsync('review-edit');
        await changeText(screen, 'review-field-summary', 'Discard this edit');
        await screen.pressByTestIdAsync('review-cancel');
        await screen.pressByTestIdAsync('review-use');
        expect(onComplete).toHaveBeenCalledWith({ mode: 'use_result', expectedContentRevision: '7' });
    });
    it('offers typed Wait values without Generate or Discuss, and fieldless Continue', async () => {
        const { screen, onComplete } = await mount({ waitForYou: true, progress: progress({ blockKind: 'wait', result: undefined }), onDiscuss: vi.fn() });
        expect(screen.findByTestId('review-generate')).toBeNull();
        expect(screen.findByTestId('review-discuss')).toBeNull();
        await changeText(screen, 'review-field-summary', 'Human value');
        await screen.pressByTestIdAsync('review-field-approved:true');
        await screen.pressByTestIdAsync('review-use');
        expect(onComplete).toHaveBeenCalledWith({ mode: 'use_result', expectedContentRevision: '7', value: { summary: 'Human value', approved: true } });
        const empty = await mount({ waitForYou: true, contract: undefined, progress: progress({ blockKind: 'wait', result: undefined }) });
        await empty.screen.pressByTestIdAsync('review-use');
        expect(empty.onComplete).toHaveBeenCalledWith({ mode: 'use_result', expectedContentRevision: '7' });
    });
    it('guides an untouched Wait without an error alert, then states a touched field problem once', async () => {
        const { screen } = await mount({ waitForYou: true, progress: progress({ blockKind: 'wait', result: undefined }) });
        expect(screen.findByTestId('review-use')?.props.disabled).toBe(true);
        expect(screen.findByTestId('review-validation')).not.toBeNull();
        expect(screen.findByTestId('review-validation')?.props.accessibilityRole).not.toBe('alert');
        expect(screen.getTextContent()).toContain('workflows.review.enterValues');
        expect(screen.getTextContent()).not.toContain('workflows.review.noValue');
        expect(screen.getTextContent()).not.toContain('workflows.review.invalid');
        expect(screen.getTextContent()).not.toContain('workflows.issue.');
        await changeText(screen, 'review-field-summary', 'x');
        await changeText(screen, 'review-field-summary', '');
        const text = screen.getTextContent();
        expect(screen.findByTestId('review-validation')?.props.accessibilityRole).toBe('alert');
        expect(text.split('workflows.review.invalid').length - 1).toBe(1);
        // Only the touched field speaks; the untouched required boolean stays quiet.
        expect(text.split('workflows.issue.').length - 1).toBe(1);
    });
    it.each([false, true])('shows the authored Wait question while respecting hosted identity ownership (%s)', async (hosted) => {
        const { screen } = await mount({ waitForYou: true, progress: progress({ blockKind: 'wait', result: undefined }),
            waitIdentity: { ...(hosted ? {} : { title: 'Check the release', subtitle: 'Reviewer lane · Attempt 2' }),
                prompt: 'Check **the release notes** before continuing.' } });
        if (hosted) {
            expect(screen.getTextContent()).not.toContain('Check the release');
            expect(screen.getTextContent()).not.toContain('workflows.review.waitTitle');
        } else {
            expect(screen.getTextContent()).toContain('Check the release');
            expect(screen.getTextContent()).toContain('Reviewer lane · Attempt 2');
            expect(screen.getTextContent()).toContain('workflows.review.waitTitle');
        }
        expect(screen.getTextContent()).toContain('workflows.review.waitBody');
        expect(screen.findHostByTestId('review-wait-prompt')).not.toBeNull();
        expect(screen.getTextContent()).toContain('the release notes');
        expect(screen.findAllHostsByTestId('review-use')).toHaveLength(1);
    });
    it('offers permitted decision values without asking a person to author JSON', async () => {
        const { screen, onComplete } = await mount({ waitForYou: true,
            contract: { kind: 'decision', decisions: ['continue', 'stop'] },
            progress: progress({ blockKind: 'wait', result: undefined }) });
        await screen.pressByTestIdAsync('review-decision:continue');
        await screen.pressByTestIdAsync('review-use');
        expect(onComplete).toHaveBeenCalledWith({ mode: 'use_result', expectedContentRevision: '7', value: 'continue' });
        expect(screen.findAllHostsByTestId('review-editor')).toHaveLength(0);
    });
    it('does not describe a required boolean value as optional', async () => {
        const { screen } = await mount({ waitForYou: true,
            progress: progress({ blockKind: 'wait', result: undefined }) });
        expect(screen.findAllHostsByTestId('review-field-approved:unset')).toHaveLength(0);
    });
    it('records offline Generate intent and describes the canonical pending request while keeping Use available', async () => {
        const { screen, onComplete } = await mount({ machineReachable: false, machineName: 'Devbox',
            progress: progress({ review: { decision: { kind: 'generate', requestedFromContentRevision: '6' } } }) });
        expect(screen.findByTestId('review-generation-requested')).not.toBeNull();
        expect(screen.findByTestId('review-use')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('review-generate');
        expect(onComplete).toHaveBeenCalledWith({ mode: 'generate', expectedContentRevision: '7' });
    });
    it('uses raw JSON for advanced schemas without dropping undeclared fields', async () => {
        const { screen, onComplete } = await mount({ contract: { kind: 'json', schema: {
            type: 'object', allOf: [{ required: ['nested'] }], properties: { nested: { type: 'object' } },
        } }, progress: progress({ result: { nested: { values: [1, 2] }, preserved: 'yes' } }) });
        await screen.pressByTestIdAsync('review-edit');
        const value = { nested: { values: [1, 2, 3] }, preserved: 'yes' };
        await changeText(screen, 'review-editor', JSON.stringify(value));
        await screen.pressByTestIdAsync('review-use');
        expect(onComplete).toHaveBeenCalledWith({ mode: 'use_result', expectedContentRevision: '7', value });
    });
    it('detects Plan from shown JSON, gates Run on proposal validity, and retains completed Plan actions', async () => {
        const onEditPlan = vi.fn(async () => {});
        const onRunPlan = vi.fn(async () => {});
        const value = { document: '# Plan\nDo the work.', proposal: { name: 'Proposed' } };
        const options = { contract: { kind: 'json', schema: { type: 'object' } }, progress: progress({ result: value }),
            planProposalValid: true, onEditPlan, onRunPlan, lifecycle: 'completed' } satisfies Partial<WorkflowReviewCardProps>;
        const { screen, onComplete } = await mount(options);
        expect(screen.findByTestId('review-plan-document')).not.toBeNull();
        expect(screen.findByTestId('review-use')).toBeNull();
        await screen.pressByTestIdAsync('review-plan-run');
        await screen.pressByTestIdAsync('review-plan-edit');
        expect(onRunPlan).toHaveBeenCalledWith(value, '7');
        expect(onEditPlan).toHaveBeenCalledWith(value, '7');
        expect(onComplete).not.toHaveBeenCalled();
        const invalid = await mount({ ...options, planProposalValid: false, lifecycle: 'waiting_for_review' });
        expect(invalid.screen.findByTestId('review-plan-run')).toBeNull();
        expect(invalid.screen.findByTestId('review-plan-edit')).not.toBeNull();
    });
    it('keeps one primary action outside the phone value scroller', async () => {
        const { screen } = await mount({ primaryActionPlacement: 'footer' });
        expect(screen.findAllHostsByTestId('review-use')).toHaveLength(1);
        const primary = screen.findByTestId('review-primary');
        const scroll = screen.findByTestId('review-scroll');
        expect(primary).not.toBeNull();
        expect(scroll).not.toBeNull();
        expect(scroll?.findAll((node) => node.props.testID === 'review-primary')).toHaveLength(0);
    });
});
