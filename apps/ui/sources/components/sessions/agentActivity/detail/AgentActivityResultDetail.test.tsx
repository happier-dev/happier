import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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
    return createTextModuleMock({ translate: (key: string) => key.split('.').pop() ?? key });
});

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

function collectText(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (!value || typeof value !== 'object') return '';
    if (Array.isArray(value)) return value.map(collectText).join('');
    const record = value as { children?: unknown };
    return collectText(record.children);
}

async function render(text: string) {
    const { AgentActivityResultDetail } = await import('./AgentActivityResultDetail');
    let tree: renderer.ReactTestRenderer | undefined;
    act(() => {
        tree = renderer.create(<AgentActivityResultDetail text={text} detailTestID="detail" />);
    });
    return tree as renderer.ReactTestRenderer;
}

describe('AgentActivityResultDetail', () => {
    it('pretty-prints JSON payloads instead of dumping the raw source', async () => {
        const tree = await render('{"status":"done","count":2}');
        const body = tree.root.findByProps({ testID: 'detail-body' });
        const rendered = collectText(body.props.children);
        expect(rendered).toContain('"status": "done"');
        expect(rendered).toContain('\n');
        act(() => tree.unmount());
    });

    it('clamps long bodies to a line budget and offers a Show more toggle', async () => {
        const long = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
        const tree = await render(long);
        const toggle = tree.root.findByProps({ testID: 'detail-show-more' });
        // Collapsed: only the first 6 lines are shown.
        expect(collectText(tree.root.findByProps({ testID: 'detail-body' }).props.children).split('\n')).toHaveLength(6);
        act(() => toggle.props.onPress());
        // Expanded: full body.
        expect(collectText(tree.root.findByProps({ testID: 'detail-body' }).props.children).split('\n')).toHaveLength(20);
        act(() => tree.unmount());
    });

    it('does not render a toggle for short bodies', async () => {
        const tree = await render('all done');
        expect(() => tree.root.findByProps({ testID: 'detail-show-more' })).toThrow();
        act(() => tree.unmount());
    });
});
