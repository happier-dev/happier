import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveDirectoryInCheckout } from './resolveDirectoryInCheckout';

describe('resolveDirectoryInCheckout', () => {
  it('refuses a checkout escape in the admitted guest even when the same controller path stays inside', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-guest-checkout-'));
    try {
      const controller = join(root, 'controller');
      const guest = join(root, 'guest');
      for (const backing of [controller, guest]) {
        await mkdir(join(backing, 'source', 'project'), { recursive: true });
        await mkdir(join(backing, 'checkout'));
      }
      await mkdir(join(controller, 'checkout', 'project'));
      const outside = join(guest, 'outside');
      await mkdir(outside);
      await symlink(outside, join(guest, 'checkout', 'project'), process.platform === 'win32' ? 'junction' : 'dir');
      const paths = {
        sourceDirectory: join(controller, 'source', 'project'),
        sourceRootPath: join(controller, 'source'),
        checkoutRootPath: join(controller, 'checkout'),
      };
      await expect(resolveDirectoryInCheckout(paths)).resolves.toBe(join(controller, 'checkout', 'project'));
      // Only the guest filesystem transport is replaced. Both real link trees exist.
      const guestSource = {
        realpath: async (path: string) => {
          const physical = await realpath(join(guest, relative(controller, path)));
          return join(controller, relative(await realpath(guest), physical));
        },
      };
      await expect(resolveDirectoryInCheckout({ ...paths, source: guestSource }))
        .rejects.toMatchObject({ code: 'directory_outside_checkout' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
