import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveDirectoryInCheckout } from './resolveDirectoryInCheckout';

describe('resolveDirectoryInCheckout', () => {
  it('maps the selected nested directory into the materialized checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-checkout-directory-'));
    try {
      const source = join(root, 'source');
      const checkout = join(root, 'checkout');
      await mkdir(join(source, 'packages', 'app'), { recursive: true });
      await mkdir(join(checkout, 'packages', 'app'), { recursive: true });
      await expect(resolveDirectoryInCheckout({
        sourceDirectory: join(source, 'packages', 'app'),
        sourceRootPath: source,
        checkoutRootPath: checkout,
      })).resolves.toBe(join(checkout, 'packages', 'app'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a nested destination symlink escaping the materialized checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-checkout-containment-'));
    try {
      const source = join(root, 'source');
      const checkout = join(root, 'checkout');
      const outside = join(root, 'outside');
      await mkdir(join(source, 'packages', 'app'), { recursive: true });
      await mkdir(checkout);
      await mkdir(outside);
      await symlink(outside, join(checkout, 'packages'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(resolveDirectoryInCheckout({
        sourceDirectory: join(source, 'packages', 'app'),
        sourceRootPath: source,
        checkoutRootPath: checkout,
      })).rejects.toMatchObject({ code: 'directory_outside_checkout' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves a missing nested leaf behind a symlink that stays inside the checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-checkout-contained-link-'));
    try {
      const source = join(root, 'source');
      const checkout = join(root, 'checkout');
      await mkdir(join(source, 'packages', 'app'), { recursive: true });
      await mkdir(join(checkout, 'shared'), { recursive: true });
      await symlink(join(checkout, 'shared'), join(checkout, 'packages'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(resolveDirectoryInCheckout({
        sourceDirectory: join(source, 'packages', 'app'),
        sourceRootPath: source,
        checkoutRootPath: checkout,
      })).resolves.toBe(join(checkout, 'packages', 'app'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
