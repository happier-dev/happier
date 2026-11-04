import { describe, expect, it } from 'vitest';

import { resolvePluginUiIconName } from '@/components/plugins/surfaces/iconToken/resolvePluginUiIconToken';
import { SESSION_SECTION_ICON_CHOICES } from '@/components/sessions/organization/sessionSectionIcons';
import { COLLECTION_SPACE_GLYPHS } from '@/components/ui/lists/collection/collectionSpaceGlyphs';
import { suggestSessionSpaceIcon } from './sessionSpaceIconSuggestion';

const section = (sectionId: string) => ({ serverId: 'home-a', sectionId });
const icons: Record<string, string> = {
  reviews: 'eye',
  launch: 'rocket',
  plain: '',
};
const readSectionIcon = (address: { sectionId: string }) =>
  icons[address.sectionId] ?? null;

describe('the icon a new Session space suggests', () => {
  it("leads with the one chosen Section's own icon, even when a Project is also chosen", () => {
    expect(
      suggestSessionSpaceIcon(
        {
          sections: { include: [section('reviews')], exclude: [] },
          projects: {
            include: [{ serverId: 'home-a', projectKey: 'happier' }],
            exclude: [],
          },
        },
        readSectionIcon,
      ),
    ).toEqual({ kind: 'icon', name: 'review' });
  });

  it.each(SESSION_SECTION_ICON_CHOICES)(
    'gives a Section with the %s icon that exact mark, offered among the picker tiles',
    (choice) => {
      const suggested = suggestSessionSpaceIcon(
        { sections: { include: [section('chosen')], exclude: [] } },
        () => choice,
      );
      if (suggested.kind !== 'icon') throw new Error('expected a glyph');
      expect(resolvePluginUiIconName(suggested.name, 'ltr')).toBe(choice);
      expect(COLLECTION_SPACE_GLYPHS).toContain(suggested.name);
    },
  );

  it('keeps the Section lines when it has no icon or a stored name outside the choices', () => {
    for (const sectionId of ['plain', 'unknown']) {
      expect(
        suggestSessionSpaceIcon(
          { sections: { include: [section(sectionId)], exclude: [] } },
          (address) => (address.sectionId === 'unknown' ? 'not-an-icon' : ''),
        ),
      ).toEqual({ kind: 'icon', name: 'list' });
    }
  });

  it('falls back to one Project, then Needs me, then the list lines', () => {
    const project = { serverId: 'home-a', projectKey: 'happier' };
    expect(
      suggestSessionSpaceIcon(
        {
          sections: {
            include: [section('reviews'), section('launch')],
            exclude: [],
          },
          projects: { include: [project], exclude: [] },
        },
        readSectionIcon,
      ),
    ).toEqual({ kind: 'project', project });
    expect(
      suggestSessionSpaceIcon(
        { attention: 'needs_my_attention' },
        readSectionIcon,
      ),
    ).toEqual({ kind: 'icon', name: 'attention' });
    expect(suggestSessionSpaceIcon({}, readSectionIcon)).toEqual({
      kind: 'icon',
      name: 'list',
    });
  });
});
