import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPassThroughModule } from '@/dev/testkit/mocks/components';
import { renderScreen } from '@/dev/testkit';
import { installTranscriptCommonModuleMocks, resetTranscriptCommonModuleMockState } from './transcriptTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installTranscriptCommonModuleMocks({
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        const base = await createUnistylesMock();
        const error = () => new Error('StyleSheet.create expected to be called with one argument.');
        return {
            ...base,
            StyleSheet: {
                ...base.StyleSheet,
                create: (...args: [unknown]) => {
                    const [input] = args;
                    if (args.length !== 1 || typeof input !== 'function') {
                        throw error();
                    }
                    const { theme, rt } = base.useUnistyles();
                    return (input as (theme: unknown, runtime: unknown) => unknown)(theme, rt);
                },
            },
        };
    },
});

vi.mock('@/components/ui/text/Text', () => createPassThroughModule(['Text']));

describe('CommandView (selection)', () => {
    afterEach(resetTranscriptCommonModuleMockState);

  it('renders command + output text as selectable', async () => {
    const { CommandView } = await import('./CommandView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<CommandView
          command="echo hi"
          stdout={'hello\nworld'}
          stderr={'warn'}
          error={'oops'}
        />)).tree;

    const texts = tree.findAllByType('Text' as any);
    expect(texts.length).toBeGreaterThan(0);
    for (const node of texts) {
      expect(node.props.selectable).toBe(true);
    }
  });

  it('renders legacy output text as selectable', async () => {
    const { CommandView } = await import('./CommandView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<CommandView
          command="echo legacy"
          // Legacy path: `output` used when stdout/stderr/error are all undefined.
          output={'legacy output'}
        />)).tree;

    const texts = tree.findAllByType('Text' as any);
    expect(texts.length).toBeGreaterThan(0);
    for (const node of texts) {
      expect(node.props.selectable).toBe(true);
    }
  });

  it('decorates the selected UTF-16 output span while preserving selectable command output', async () => {
    const { CommandView } = await import('./CommandView');
    const screen = await renderScreen(<CommandView command="echo hi" stdout="😀 needle remainder"
      stdoutFindRanges={[{ start: 3, end: 9, current: true }]} />);
    const match = screen.findByTestId('find-match-current');
    if (!match) throw new Error('Expected the selected command-output match');
    expect(match.props.children).toBe('needle');
    expect(screen.getTextContent()).toContain('😀 needle remainder');
    const output = screen.tree.findAllByType('Text' as never).find((node) => node.props.children?.props?.text === '😀 needle remainder');
    expect(output?.props.selectable).toBe(true);
  });
});
