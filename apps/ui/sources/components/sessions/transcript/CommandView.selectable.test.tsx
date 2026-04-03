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
});
