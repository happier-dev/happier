import { afterEach, expect, it, vi } from 'vitest';
import { createDeploymentMoveFixture } from './deploymentMove.testkit';

afterEach(() => vi.unstubAllEnvs());

it.each([{ attach: false, create: false, existingCheckout: false }, { attach: true, create: false, existingCheckout: false },
  { attach: true, create: true, existingCheckout: false }, { attach: true, create: true, existingCheckout: true }])(
  'reviews a stored definition without changing its Source or repository (attach=$attach create=$create existingCheckout=$existingCheckout)', async ({ attach, create, existingCheckout }) => {
    const fixture = await createDeploymentMoveFixture({ attach, create, existingCheckout });
    try {
      const beforeSource = structuredClone(fixture.readSource());
      const result = await fixture.executeMove(fixture.input);
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: {
        kind: create ? 'previewCreate' : 'preview', review: { document: fixture.initial.document,
          workspace: fixture.input.workspace, path: fixture.input.path,
          ...(!create ? { before: 'base\n' } : {}),
          files: [
            ...(create && !existingCheckout ? [{ path: 'README.md', before: null, content: '# app\n' }] : []),
            { path: fixture.input.path, before: create && !existingCheckout ? null : 'base\n', content: fixture.initial.document },
            { path: 'runtime.env', before: null, content: 'PUBLIC_VALUE=one\n' },
          ],
        },
      } });
      expect(fixture.readSource()).toEqual(beforeSource);
      expect(fixture.detail.content.definition).toEqual(fixture.initial);
      expect(fixture.forge.repositoryCreated()).toBe(!create);
    } finally {
      await fixture.cleanup();
    }
  },
);
