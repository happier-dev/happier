import { describe, expect, it } from 'vitest';

import {
  AutomationSessionLifecycleConfigurationSchema,
  projectAutomationSessionLifecycleStructuralConfiguration,
  projectAutomationSessionLifecycleLaunchProfileId,
  matchesAutomationSessionLifecycleFilter,
} from './automationSessionLifecycle.js';

describe('Session lifecycle habit filters', () => {
  it('keeps authored profile selection private and projects one matching filter', () => {
    const filter = { v: 1, all: [
      { field: '/launchProfileId', op: 'in', values: ['profile-a', 'profile-b'] },
      { field: '/changedFiles', op: 'eq', value: true },
    ] };
    const authored = AutomationSessionLifecycleConfigurationSchema.parse({
      events: ['parentTurnCompleted'], policy: { kind: 'everyMatch' }, filter,
    });
    expect(authored).toMatchObject({ filter });
    const projected = projectAutomationSessionLifecycleStructuralConfiguration(authored);
    expect(projected).toHaveProperty('filter');
    expect(JSON.stringify(projected)).not.toContain('profile-a');
    expect(JSON.stringify(projected)).not.toContain('profile-b');
    expect(matchesAutomationSessionLifecycleFilter(projected.filter, {
      launchProfileId: projectAutomationSessionLifecycleLaunchProfileId('profile-b'), changedFiles: true,
    })).toBe(true);
    expect(matchesAutomationSessionLifecycleFilter(projected.filter, {
      launchProfileId: projectAutomationSessionLifecycleLaunchProfileId('profile-c'), changedFiles: true,
    })).toBe(false);
  });

  it('never treats missing or unavailable file evidence as a clean turn', () => {
    const filter = AutomationSessionLifecycleConfigurationSchema.parse({
      events: ['parentTurnCompleted'], policy: { kind: 'everyMatch' },
      filter: { v: 1, all: [{ field: '/changedFiles', op: 'eq', value: false }] },
    }).filter;
    expect(matchesAutomationSessionLifecycleFilter(filter, undefined)).toBe(false);
    expect(matchesAutomationSessionLifecycleFilter(filter, { changedFiles: null })).toBe(false);
    expect(matchesAutomationSessionLifecycleFilter(filter, { changedFiles: false })).toBe(true);
    expect(matchesAutomationSessionLifecycleFilter(undefined, undefined)).toBe(true);
  });
});
