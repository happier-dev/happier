import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const { DiffViewer } = await import('../DiffViewer');
const { Text } = await import('@/components/ui/text/Text');
afterEach(() => { standardCleanup(); });

const labels = { oldLabel: <Text>Yours</Text>, newLabel: <Text>Theirs</Text> };

it('renders the prose face as two labelled sides with no code-diff hunk header', async () => {
    const screen = await renderScreen(<DiffViewer mode="text" face="prose" testID="prose" presentationStyleOverride="split"
        oldText={'a\nWarn above 2 GB.\nc\n'} newText={'a\nWarn above 1 GB.\nc\n'} prose={{ ...labels, kept: 'old' }} />);
    const text = screen.getTextContent();
    expect(text).toContain('Yours');
    expect(text).toContain('Theirs');
    expect(text).toContain('Warn above 2 GB.');
    expect(text).toContain('Warn above 1 GB.');
    expect(text).not.toContain('@@');
});

it('shows only the side that has the file when the other has none', async () => {
    const screen = await renderScreen(<DiffViewer mode="text" face="prose" testID="prose"
        oldText="" newText={'import sys\n'} prose={labels} />);
    expect(screen.getTextContent()).toContain('Theirs');
    expect(screen.getTextContent()).not.toContain('Yours');
});

it('reads an inline prose edit as one column: context once, each change marked where it happens', async () => {
    const screen = await renderScreen(<DiffViewer mode="text" face="prose" testID="prose" prose={{ inline: true }}
        oldText={'Keep notes plain.\nNever publish without asking.'}
        newText={'Keep notes plain.\nCheck prerelease versions first.\nNever publish without asking.'} />);
    const text = screen.getTextContent();
    expect(text.split('Keep notes plain.').length - 1).toBe(1);
    expect(text.split('Never publish without asking.').length - 1).toBe(1);
    expect(screen.findAllByTestId('prose.added')).toHaveLength(1);
    expect(screen.findAllByTestId('prose.removed')).toHaveLength(0);
});

it('keeps two labelled sides on a narrow (unified) compare, so a side can still be chosen', async () => {
    const screen = await renderScreen(<DiffViewer mode="text" face="prose" testID="prose" presentationStyleOverride="unified"
        oldText={'a\nWarn above 2 GB.\n'} newText={'a\nWarn above 1 GB.\n'} prose={{ ...labels, kept: 'new' }} />);
    expect(screen.getTextContent()).toContain('Yours');
    expect(screen.getTextContent()).toContain('Theirs');
    expect(screen.findAllByTestId('prose.added')).toHaveLength(0);
});

it('reads a one-passage edit as one run of words: only the changed words are marked, in place', async () => {
    const screen = await renderScreen(<DiffViewer mode="text" face="prose" testID="prose" prose={{ ...labels, words: true }}
        oldText="A replay shows two rows with the same key."
        newText="A replay shows one row with a replayed badge." />);
    const read = (testID: string) => screen.findAllHostsByTestId(testID).map((node) => [node.props.children].flat().join('')).join('|');
    expect(read('prose.removed')).toContain('two rows');
    expect(read('prose.removed')).not.toContain('replay shows');
    expect(read('prose.added')).toContain('one row');
    // One column of words, not two labelled sides: the sentence's unchanged words are read once.
    expect(screen.getTextContent().split('A replay shows').length - 1).toBe(1);
});
