import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(() => standardCleanup());

const { DomainDnsComparison } = await import('./DomainDnsComparison');
const stripFacts = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.root.findAll((node) =>
  node.props?.testID === 'deployment-domain-dns-comparison.facts' && Array.isArray(node.props?.facts))[0]!.props.facts;
const expander = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.root.findAll((node) =>
  node.props?.testID === 'deployment-domain-dns-comparison' && typeof node.props?.onExpandedChange === 'function')[0]!;

it('opens Points elsewhere in place: the check runs once, then Expected, the answered records and the next step read from its result', async () => {
  const onOpen = vi.fn();
  const comparison = { expectedIpv4: '49.12.91.7', answered: { A: ['49.12.88.14'], AAAA: [] } } as const;
  const screen = await renderScreen(<DomainDnsComparison mismatch generated onOpen={onOpen} comparison={comparison as never} />);
  await act(async () => { expander(screen).props.onExpandedChange(true); });
  expect(onOpen).toHaveBeenCalledOnce();
  const facts = stripFacts(screen) as readonly { key: string; value: string; tone?: string }[];
  expect(facts.map((fact) => [fact.key, fact.value, fact.tone ?? null])).toEqual([
    ['expected', 'A 49.12.91.7', null],
    ['answered', 'A 49.12.88.14', 'attention'],
    ['next', expect.any(String), null],
  ]);
});

it('says Unavailable rather than inventing records before the check answers', async () => {
  const screen = await renderScreen(<DomainDnsComparison mismatch={false} />);
  await act(async () => { expander(screen).props.onExpandedChange(true); });
  const facts = stripFacts(screen) as readonly { key: string; tone?: string }[];
  expect(facts.map((fact) => fact.key)).toEqual(['expected', 'answered']);
  expect(facts.some((fact) => fact.tone)).toBe(false);
});
