import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { RoleArtifactV1 } from '@happier-dev/protocol/prompts/roles/roleArtifactV1';
import { HappierRoleMark, HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';

import { Icon } from '@/components/ui/icons/Icon';

import { useRoleEnginePresentation } from './useRoleEnginePresentation';

/**
 * A role's mark wherever a role is listed or opened: the agent it pins, in the Agent catalog's own
 * identity; a role that pins no engine runs on whichever agent starts it, so it carries the role's own
 * glyph instead (`HappierRoleMark`), never a generic person.
 */
export function useRoleMark(): (
  role: Pick<RoleArtifactV1, 'engine' | 'runsAs'>,
  size: number,
  roleId?: string,
) => React.ReactNode {
  const presentEngine = useRoleEnginePresentation();
  const { theme } = useUnistyles();
  return React.useCallback(
    (role, size, roleId) => {
      const engine = presentEngine(role.engine, size);
      // Until the Agent catalog names the agent an unpinned role follows, its mark is a quiet block of the same size.
      const agentMark = engine.pending
        ? <HappierSkeletonBlock width={size} height={size} radius={size / 2} color={theme.colors.surface.skeleton} />
        : engine.icon;
      return <HappierRoleMark roleId={roleId} runsAs={role.runsAs.kind} agentMark={agentMark} renderGlyph={(glyph) => (
        <Icon
          name={glyph}
          size={size}
          color={theme.colors.text.secondary}
        />
      )} />;
    },
    [presentEngine, theme.colors.surface.pressedOverlay, theme.colors.text.secondary],
  );
}
