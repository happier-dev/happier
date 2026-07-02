/**
 * Public barrel for the CommandMenu primitive. Consumers SHOULD import
 * exclusively from `@/components/ui/commandMenu`, not from individual submodule
 * files. Re-exports are explicit so the public surface is auditable.
 */

export { CommandMenu } from './CommandMenu';
export { CommandMenuRow } from './CommandMenuRow';
export { CommandMenuSurface } from './CommandMenuSurface';
export { filterCommandMenuItemsBySubstring } from './filterCommandMenuItemsBySubstring';
export { useCommandMenuKeyboard } from './useCommandMenuKeyboard';

export type {
    CommandMenuAnchor,
    CommandMenuItem,
    CommandMenuProps,
} from './commandMenuTypes';
