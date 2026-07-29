import { describe, expect, it, vi } from 'vitest';

import type {
  HostCurrentSessionInteractionsService,
  HostCurrentSessionUiServices,
} from '@/agent/runtime/state/currentSessionUiTypes';

import {
  registerCurrentSessionUiBinding,
  resolveCurrentSessionUiBinding,
} from './currentSessionUiBindings';

const request = vi.fn() as HostCurrentSessionInteractionsService['request'];
const service: HostCurrentSessionUiServices = Object.freeze({
  interactions: Object.freeze({ request }),
});

describe('current-session UI bindings', () => {
  it('exposes only the current live native-session binding and does not let stale disposal remove its successor', () => {
    const first = new AbortController();
    const second = new AbortController();
    let firstCurrent = true;
    const disposeFirst = registerCurrentSessionUiBinding({
      sessionId: 's1',
      service,
      signal: first.signal,
      isCurrent: () => firstCurrent,
    });
    expect(resolveCurrentSessionUiBinding('s1')).toBe(service);

    const successor: HostCurrentSessionUiServices = Object.freeze({
      interactions: Object.freeze({
        request: vi.fn() as HostCurrentSessionInteractionsService['request'],
      }),
    });
    registerCurrentSessionUiBinding({
      sessionId: 's1',
      service: successor,
      signal: second.signal,
      isCurrent: () => true,
    });
    firstCurrent = false;
    disposeFirst();
    expect(resolveCurrentSessionUiBinding('s1')).toBe(successor);

    second.abort();
    expect(resolveCurrentSessionUiBinding('s1')).toBeNull();
  });
});
