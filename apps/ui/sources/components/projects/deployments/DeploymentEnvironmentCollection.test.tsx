import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { environmentAfterDelete } = await import('./DeploymentEnvironmentCollection');

const row = (id: string, projectSourceId = 'source-app') => ({ environment: { id, projectSourceId } }) as never;

describe('selection after an Environment is deleted', () => {
  it('opens the nearest sibling of the same Project, the next one before the previous one', () => {
    const items = [row('a'), row('b'), row('c')];
    expect(environmentAfterDelete(items, 'b', 'source-app')).toBe('c');
    expect(environmentAfterDelete(items, 'c', 'source-app')).toBe('b');
  });

  it('never lands on another Project’s Environment; with no sibling it is the empty state', () => {
    expect(environmentAfterDelete([row('x', 'source-other'), row('a'), row('y', 'source-other')], 'a', 'source-app')).toBeNull();
    expect(environmentAfterDelete([row('a')], 'a', 'source-app')).toBeNull();
  });
});
