import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { AskHappierMark } from '@/components/sessions/bots/AskHappierOfferCard';
import { Icon } from '@/components/ui/icons/Icon';
import { HappierBrandMark, type HostCatalogMark } from '@/components/ui/media/HappierBrandMark';

/**
 * A skill has no brand mark of its own: its kind glyph (the Skills page's icon) stands in the row's mark column, so
 * skill titles align with every other identity row in a list (S10 §5.2: a glyph is 20, centred in the 32 box).
 */
export const SkillKindGlyph = React.memo(function SkillKindGlyph(props: Readonly<{ size?: number }>) {
  const { theme } = useUnistyles();
  return <Icon name="lightbulb" size={props.size ?? 20} color={theme.colors.text.secondary} />;
});

/**
 * A skill's one mark wherever it is listed (Skills rail, shelf cards, Store rows, Add, Profile seeds, capability
 * scope; X3): Happier's own skill carries Happier's mark, as its built-in MCP server row does (lab k:home); a skill
 * whose listing admits artwork draws that; every other skill the kind glyph, never a letter.
 */
export const SkillMark = React.memo(function SkillMark(props: Readonly<{ firstParty?: boolean; size?: number; brand?: HostCatalogMark | null }>) {
    const size = props.size ?? 20;
    if (props.firstParty === true) return <AskHappierMark size={size} />;
    const brand = props.brand;
    if (brand && (brand.bytes || brand.light || brand.dark)) return <HappierBrandMark brand={brand} pixelSize={size} externallyLabelled />;
    return <SkillKindGlyph size={size} />;
});
