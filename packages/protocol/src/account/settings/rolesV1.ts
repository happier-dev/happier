import { z } from 'zod';

import { RoleOverrideCatalogV1Schema } from '../../prompts/roles/roleOverrideRecordV1.js';
import { ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES, withAccountSettingBounds } from './catalog/accountSettingBounds.js';

/** Read-only predecessor override carrier; current overrides use prompt-library rows. */
export const RolesV1Schema = withAccountSettingBounds(RoleOverrideCatalogV1Schema, ACCOUNT_SETTINGS_MAX_DOCUMENT_BYTES);
export type RolesV1 = z.infer<typeof RolesV1Schema>;
