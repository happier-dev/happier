import type { Locator, Page } from '@playwright/test';

function tileByDisplayName(params: Readonly<{
  root: Locator;
  page: Page;
  tilePrefix: string;
  displayName: string;
}>): Locator {
  return params.root
    .locator(`[data-testid^="${params.tilePrefix}"]`)
    .filter({ has: params.page.getByText(params.displayName, { exact: true }) })
    .first();
}

export function detectedPetTileByDisplayName(params: Readonly<{
  page: Page;
  displayName: string;
}>): Locator {
  return tileByDisplayName({
    root: params.page.locator('body'),
    page: params.page,
    tilePrefix: 'settings-pets-detected-tile-',
    displayName: params.displayName,
  });
}

export function localLibraryPetTileByDisplayName(params: Readonly<{
  page: Page;
  localLibrary: Locator;
  displayName: string;
}>): Locator {
  return tileByDisplayName({
    root: params.localLibrary,
    page: params.page,
    tilePrefix: 'settings-pets-local-tile-',
    displayName: params.displayName,
  });
}

export function accountLibraryPetTileByDisplayName(params: Readonly<{
  page: Page;
  accountLibrary: Locator;
  displayName: string;
}>): Locator {
  return tileByDisplayName({
    root: params.accountLibrary,
    page: params.page,
    tilePrefix: 'settings-pets-account-tile-',
    displayName: params.displayName,
  });
}

export function tileSubnodeByTestIdPrefix(params: Readonly<{
  tile: Locator;
  prefix: string;
}>): Locator {
  return params.tile.locator(`[data-testid^="${params.prefix}"]`).first();
}
