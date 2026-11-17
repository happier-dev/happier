import * as React from 'react';
import { View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter, type Href } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  BotFaceShapeV1,
  BotFaceStyle,
  SessionBotFaceV1,
} from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import type { PetAccountReferenceV1 } from '@happier-dev/protocol/pets/selection';

import { BUILT_IN_PET_IDS, DEFAULT_BUILT_IN_PET_ID, resolveBuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import { usePetReferencePackage } from '@/components/pets/source/usePetReferencePackage';
import { useCreatePetSession } from '@/components/pets/useCreatePetSession';
import { buildPluginsHomeRoute, PLUGINS_SURFACE_ICON } from '@/components/settings/plugins/model/pluginsSurfaceRoutes';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { SelectionTiles } from '@/components/ui/forms/SelectionTiles';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { Text } from '@/components/ui/text/Text';
import { randomUUID } from '@/platform/randomUUID';
import { storage, usePeripheralFeedDemand, useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { BotFace } from './face/BotFace';
import { SessionBotFacePet } from './face/SessionBotFace';
import {
  BOT_FACE_BODY_IDS,
  BOT_FACE_COLOURS,
  BOT_FACE_COLOUR_IDS,
  botFaceGradient,
  type BotFaceBodyId,
  type BotFaceColourId,
} from './face/botFaceArt';
import {
  BOT_FACE_STYLES,
  botFaceSeedNumber,
  resolveBotFaceIdentity,
} from './face/botFaceIdentity';
import { generateBotFaceShape } from '@happier-dev/protocol/sessions/identity/sessionBotFaceV1';

/** Lab R6 `r6-shell-N`: style tiles draw at 44 (still list forms), body tiles at 32. */
const STYLE_TILE_FACE_PX = 44;
const BODY_TILE_FACE_PX = 32;
const SWATCH_PX = 20;
/** A plain style: the third-party gradient does not receive Unistyles styles on web, so it sizes from this object. */
const SWATCH_STYLE = { width: SWATCH_PX, height: SWATCH_PX, borderRadius: SWATCH_PX / 2 } as const;
/**
 * Body and colour cells (lab R6): compact, the face or swatch centred. The floating panel has the lab's width, so its
 * cells are a little wider than tall; a phone sheet is narrower, so bodies take fewer, square cells that still hold
 * the whole 32 px face.
 */
const BODY_CELLS = {
  panel: { columns: 8, aspectRatio: 1.4 },
  sheet: { columns: 6, aspectRatio: 1 },
} as const;
const SWATCH_CELL_ASPECT_RATIO = { panel: 1.4, sheet: 1 } as const;
/** Style and pet cells carry names (lab R11 `r11-picker-P`, `Pp`): up to eight across the panel, four on a phone. */
const PET_COLUMNS = { panel: 8, sheet: 4 } as const;
const PICKER_WIDTH_PX = 560;
const PICKER_MAX_HEIGHT_PX = 640;

/** Where a deliberate face change is being saved: nothing, in flight, or refused (the choice reverted). */
export type BotFacePickerStatus = 'idle' | 'saving' | 'failed';

/**
 * A fresh Surprise me shape: drawn once per press from a locally minted seed, so the preview and the saved face are
 * the same face. The outline is what is saved, never the seed (R8 §2c).
 */
export function surpriseBotFaceShape(): BotFaceShapeV1 {
  return generateBotFaceShape(botFaceSeedNumber(randomUUID()));
}

/**
 * The face one gesture asks for. A style or colour keeps the other choices and the seed shown; a roster body replaces
 * any shape; Surprise me sets a new generated shape and keeps everything else. Account default removes only the
 * style; Use my default (null) clears every override. A pet is worn over the Bot's own style, body and colour, which
 * stay as the face it falls back to; choosing a style, a body or a new shape takes the pet off (R11).
 */
export type BotFacePickerGesture =
  | Readonly<{ kind: 'style'; style: BotFaceStyle }>
  | Readonly<{ kind: 'inheritStyle' }>
  | Readonly<{ kind: 'body'; body: BotFaceBodyId }>
  | Readonly<{ kind: 'colour'; colour: BotFaceColourId }>
  | Readonly<{ kind: 'surprise'; shape: BotFaceShapeV1 }>
  | Readonly<{ kind: 'pet'; pet: PetAccountReferenceV1 }>
  | Readonly<{ kind: 'default' }>;

export function applyBotFacePickerGesture(
  face: SessionBotFaceV1 | null,
  shownSeed: string,
  gesture: BotFacePickerGesture,
): SessionBotFaceV1 | null {
  const { pet: _worn, ...own }: SessionBotFaceV1 = face ?? {};
  switch (gesture.kind) {
    case 'style':
      return { ...own, style: gesture.style, seed: face?.seed ?? shownSeed };
    case 'inheritStyle': {
      if (!face) return null;
      const { style: _inherited, ...identity } = own;
      return identity;
    }
    case 'body': {
      const { shape: _replaced, ...rest } = own;
      return { ...rest, body: gesture.body, seed: face?.seed ?? shownSeed };
    }
    case 'colour':
      return {
        ...face,
        palette: gesture.colour,
        seed: face?.seed ?? shownSeed,
      };
    case 'surprise':
      return { ...own, seed: face?.seed ?? shownSeed, shape: gesture.shape };
    case 'pet':
      return { ...face, pet: gesture.pet, seed: face?.seed ?? shownSeed };
    case 'default':
      return null;
  }
}

/** The two shape tiles that end the body row (R8 `r8-shapes-U`). */
type BodyTileId = BotFaceBodyId | 'surprise' | 'custom';

/**
 * A Bot's face chooser (lab R6 `r6-shell-N`, R8 `r8-shapes-U`): style, body and colour as tiles drawing the real
 * face, the body row ending in Surprise me and Custom, then Use my default and Surprise me. Every option comes from the protocol catalogs the face renders. Each tap is one gesture:
 * the parent previews it at once and commits it once (a draft keeps it locally; a Bot saves it with its Action).
 */
export const BotFacePickerPanel = React.memo(function BotFacePickerPanel(
  props: Readonly<{
    /** The seed the face shown is drawn from (the saved Another-face seed, or the Bot's own). */
    seed: string;
    face: SessionBotFaceV1 | null;
    onChange: (next: SessionBotFaceV1 | null) => void;
    status?: BotFacePickerStatus;
    /** Where the chooser sits: the floating panel (default) or a phone sheet, which is narrower. */
    layout?: 'panel' | 'sheet';
    /** Add a pet leaves for Settings › Pets; the chooser closes behind it. */
    onRequestClose?: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const router = useRouter();
  const layout = props.layout ?? 'panel';
  const defaultStyle = useSetting('botFaceStyle');
  const { face, seed, onChange, onRequestClose } = props;
  const pets = usePetChoices();
  const wornLookup = usePetReferencePackage(pets.enabled ? face?.pet : null);
  // A pet the face can't show (deleted, unreadable) is not worn: the chooser shows the face the Bot actually shows.
  const worn = pets.enabled && face?.pet && wornLookup.status !== 'unavailable' ? face.pet : null;
  const wornChoice = worn ? pets.choices.find(choice => choice.id === petChoiceId(worn)) : undefined;
  const identity = React.useMemo(
    () => resolveBotFaceIdentity(seed, face),
    [seed, face?.body, face?.palette, face?.shape],
  );
  const style = face?.style ?? defaultStyle;
  // Pressing an empty Custom tile only explains how to get one; it saves nothing.
  const [customHint, setCustomHint] = React.useState(false);
  const apply = React.useCallback(
    (gesture: BotFacePickerGesture) => {
      setCustomHint(false);
      onChange(applyBotFacePickerGesture(face, seed, gesture));
    },
    [face, onChange, seed],
  );
  const surprise = React.useCallback(() => apply({ kind: 'surprise', shape: surpriseBotFaceShape() }), [apply]);
  const shapeOrigin = face?.shape ? (face.shape.origin ?? 'custom') : null;
  const bodyValue: BodyTileId = shapeOrigin ?? identity.body;
  // The Surprise tile shows the current generated shape, or the one this Bot's own seed draws.
  const surpriseShape = React.useMemo(
    () => (shapeOrigin === 'surprise' ? face!.shape! : generateBotFaceShape(botFaceSeedNumber(seed))),
    [shapeOrigin, face?.shape, seed],
  );
  const customShape = shapeOrigin === 'custom' ? face!.shape! : null;
  const styleLabel = (id: BotFaceStyle) => t(`bots.face.styles.${id}`);
  const styleOptions = React.useMemo(
    () =>
      [{
        id: 'account-default' as const,
        title: t('bots.face.accountDefault'),
        preview: (
          <View style={styles.cell}>
            <BotFace identity={identity} style={defaultStyle} size={STYLE_TILE_FACE_PX} mood="quiet" />
          </View>
        ),
      }, ...BOT_FACE_STYLES.map((id) => ({
        id,
        title: styleLabel(id),
        preview: (
          <View style={styles.cell}>
            <BotFace
              identity={identity}
              style={id}
              size={STYLE_TILE_FACE_PX}
              mood="quiet"
            />
          </View>
        ),
      })), ...(pets.enabled ? [{
        id: 'pet' as const,
        title: t('bots.face.pet'),
        // The pet worn, or Blink, the default built-in.
        preview: <View style={styles.cell}><PetTileFace pet={worn ?? DEFAULT_PET} size={STYLE_TILE_FACE_PX} /></View>,
      }] : [])],
    [identity, defaultStyle, pets.enabled, worn],
  );
  const createPet = useCreatePetSession();
  // Find a pet and Create… end the grid (R12 §13): both leave the chooser, which closes behind them.
  const findPet = React.useCallback(() => {
    onRequestClose?.();
    router.push(buildPluginsHomeRoute('app', { view: 'kind', kind: 'pet' }) as Href);
  }, [onRequestClose, router]);
  const startCreatePet = React.useCallback(() => {
    onRequestClose?.();
    fireAndForget(createPet(), { tag: 'BotFacePicker.createPet' });
  }, [createPet, onRequestClose]);
  const petOptions = React.useMemo(
    () => [
      ...pets.choices.map((choice) => ({
        id: choice.id,
        title: choice.name,
        preview: <View style={styles.cell}><PetTileFace pet={choice.ref} size={BODY_TILE_FACE_PX} /></View>,
      })),
      {
        id: FIND_PET,
        title: t('bots.face.findPet'),
        preview: <ShapeTile icon={PLUGINS_SURFACE_ICON} colour={theme.colors.text.secondary}>{null}</ShapeTile>,
      },
      {
        id: CREATE_PET,
        title: t('bots.face.createPet'),
        preview: <ShapeTile icon="sparkle" colour={theme.colors.text.secondary}>{null}</ShapeTile>,
      },
    ],
    [pets.choices, theme.colors.text.secondary],
  );
  const { theme: { colors } } = useUnistyles();
  const bodyOptions = React.useMemo(
    () => [
      ...BOT_FACE_BODY_IDS.map((id) => ({
        id: id as BodyTileId,
        title: t(`bots.face.bodies.${id}`),
        preview: (
          <View style={styles.cell}>
            <BotFace
              identity={{ body: id, colour: identity.colour, seed: identity.seed }}
              style={style}
              size={BODY_TILE_FACE_PX}
              mood="quiet"
            />
          </View>
        ),
      })),
      {
        id: 'surprise' as const,
        title: t('bots.face.surprise'),
        preview: (
          <ShapeTile glyph="shuffle" colour={colors.text.secondary}>
            <BotFace identity={{ ...identity, shape: surpriseShape }} style={style} size={BODY_TILE_FACE_PX * 0.75} mood="quiet" />
          </ShapeTile>
        ),
      },
      {
        id: 'custom' as const,
        title: t('bots.face.custom'),
        preview: (
          // A phone sheet's square cell cannot hold the word; the tile keeps it as its accessible name and the
          // section value names it once chosen.
          <ShapeTile label={layout === 'panel' ? t('bots.face.custom') : undefined} colour={colors.text.secondary}>
            {customShape ? (
              <BotFace identity={{ ...identity, shape: customShape }} style={style} size={BODY_TILE_FACE_PX * 0.75} mood="quiet" />
            ) : null}
          </ShapeTile>
        ),
      },
    ],
    [identity, style, surpriseShape, customShape, colors.text.secondary, layout],
  );
  const dark = theme.dark;
  const colourOptions = React.useMemo(
    () =>
      BOT_FACE_COLOUR_IDS.map((id) => ({
        id,
        title: t(`bots.face.colours.${id}`),
        preview: (
          <View style={styles.cell}>
            <BotFaceSwatch colour={id} dark={dark} />
          </View>
        ),
      })),
    [dark],
  );
  return (
    <View style={styles.panel} testID="bot-face-picker">
      <PickerSection title={t('bots.face.style')} value={worn ? t('bots.face.pet') : face?.style ? styleLabel(style) : t('bots.face.accountDefault')}>
        <SelectionTiles
          variant="visual"
          tileSizing="fill"
          // Seven styles: a phone sheet takes them four across (lab R11 `r11-picker-Pp`), as it does pets.
          maximumColumns={PET_COLUMNS[layout]}
          accessibilityLabel={t('bots.face.style')}
          testIdPrefix="bot-face-style"
          value={worn ? 'pet' : face?.style ?? 'account-default'}
          onChange={(next) => {
            if (next === 'pet') {
              if (!worn) apply({ kind: 'pet', pet: DEFAULT_PET });
            } else if (next === 'account-default') {
              if (face?.style || worn) apply({ kind: 'inheritStyle' });
            } else if (next && (next !== face?.style || worn)) apply({ kind: 'style', style: next });
          }}
          options={styleOptions}
        />
      </PickerSection>
      {/* A pet replaces the body and colour; the Bot keeps them underneath, as the face it falls back to (R11). */}
      {worn ? (
        <PickerSection title={t('bots.face.pet')} value={wornChoice?.name ?? ''}>
          <SelectionTiles
            variant="visual"
            tileSizing="fill"
            maximumColumns={PET_COLUMNS[layout]}
            accessibilityLabel={t('bots.face.pet')}
            testIdPrefix="bot-face-pet"
            value={wornChoice?.id ?? null}
            onChange={(next) => {
              if (next === FIND_PET) findPet();
              else if (next === CREATE_PET) startCreatePet();
              else if (next && next !== wornChoice?.id) {
                const choice = pets.choices.find(candidate => candidate.id === next);
                if (choice) apply({ kind: 'pet', pet: choice.ref });
              }
            }}
            options={petOptions}
          />
        </PickerSection>
      ) : null}
      {/* Planet is the moon itself: it has no body to choose (lab R6). */}
      {worn || style === 'planet' ? null : (
        <PickerSection
          title={t('bots.face.body')}
          value={bodyValue === 'surprise' ? t('bots.face.surprise') : bodyValue === 'custom' ? t('bots.face.custom') : t(`bots.face.bodies.${bodyValue}`)}
        >
          <SelectionTiles
            variant="visual"
            tileSizing="fill"
            labels="hidden"
            previewAspectRatio={BODY_CELLS[layout].aspectRatio}
            maximumColumns={BODY_CELLS[layout].columns}
            accessibilityLabel={t('bots.face.body')}
            testIdPrefix="bot-face-body"
            value={bodyValue}
            onChange={(next) => {
              if (next === 'surprise') surprise();
              else if (next === 'custom') setCustomHint(!customShape);
              else if (next && next !== bodyValue) apply({ kind: 'body', body: next });
            }}
            options={bodyOptions}
          />
        </PickerSection>
      )}
      {worn ? null : <PickerSection
        title={t('bots.face.colour')}
        value={t(`bots.face.colours.${identity.colour}`)}
      >
        <SelectionTiles
          variant="visual"
          tileSizing="fill"
          labels="hidden"
          previewAspectRatio={SWATCH_CELL_ASPECT_RATIO[layout]}
          accessibilityLabel={t('bots.face.colour')}
          testIdPrefix="bot-face-colour"
          value={identity.colour}
          onChange={(next) => {
            if (next && next !== identity.colour)
              apply({ kind: 'colour', colour: next });
          }}
          options={colourOptions}
        />
      </PickerSection>}
      <View style={styles.footer}>
        <Text
          variant="meta"
          testID="bot-face-picker-note"
          style={[
            styles.note,
            props.status === 'failed' ? styles.failed : null,
          ]}
        >
          {props.status === 'failed'
            ? t('bots.face.failed')
            : worn
              ? worn.kind === 'accountPet'
                ? t('bots.face.petAccountNote', { name: wornChoice?.name ?? '' })
                : pets.accountCount === 0 ? t('bots.face.petEmptyNote') : ''
            : customHint
              ? t('bots.face.customEmptyNote')
              : shapeOrigin === 'custom'
                ? t('bots.face.customNote')
                : shapeOrigin === 'surprise'
                  ? t('bots.face.surpriseNote')
                  : t('bots.face.note')}
        </Text>
        <TextLinkButton
          testID="bot-face-use-default"
          label={t('bots.face.useDefault')}
          size="meta"
          disabled={face === null}
          onPress={() => apply({ kind: 'default' })}
        />
        {/* Surprise me draws a new body, which a pet would hide: it steps aside while a pet is worn. */}
        {worn ? null : (
          <TextLinkButton
            testID="bot-face-surprise"
            label={t('bots.face.surprise')}
            size="meta"
            onPress={surprise}
          />
        )}
      </View>
    </View>
  );
});

const FIND_PET = 'find-pet';
const CREATE_PET = 'create-pet';
const DEFAULT_PET: PetAccountReferenceV1 = { kind: 'builtIn', petId: DEFAULT_BUILT_IN_PET_ID };
const petChoiceId = (ref: PetAccountReferenceV1) => (ref.kind === 'builtIn' ? `builtIn:${ref.petId}` : `accountPet:${ref.accountPetId}`);
type PetChoice = Readonly<{ id: string; ref: PetAccountReferenceV1; name: string }>;
const BUILT_IN_PET_CHOICES: readonly PetChoice[] = BUILT_IN_PET_IDS.map((petId) => ({
  id: petChoiceId({ kind: 'builtIn', petId }),
  ref: { kind: 'builtIn', petId },
  name: resolveBuiltInPetPackage(petId).manifest.displayName,
}));

/**
 * The pets a face can wear (R11): the built-ins, then the Account's own pets while Pet sync is on. Device-only pets are
 * left out, since a face shows on every device; Settings › Pets imports them to the Account. Mounted only while the
 * chooser is open, so its library demand ends with it.
 */
function usePetChoices(): Readonly<{ enabled: boolean; choices: readonly PetChoice[]; accountCount: number }> {
  const enabled = useFeatureDecision('pets.companion')?.state === 'enabled';
  const syncEnabled = useFeatureDecision('pets.sync')?.state === 'enabled';
  const accountPets = enabled && syncEnabled;
  usePeripheralFeedDemand('accountPets', accountPets);
  const library = storage((state) => state.accountPetsById);
  return React.useMemo(() => {
    const own: PetChoice[] = accountPets
      ? Object.values(library).map((pet) => ({
        id: petChoiceId({ kind: 'accountPet', accountPetId: pet.accountPetId }),
        ref: { kind: 'accountPet', accountPetId: pet.accountPetId },
        name: pet.manifest.displayName,
      }))
      : [];
    return { enabled, choices: own.length ? [...BUILT_IN_PET_CHOICES, ...own] : BUILT_IN_PET_CHOICES, accountCount: own.length };
  }, [enabled, accountPets, library]);
}

/** A pet tile's face, resting: the pet a face would wear, through the face's own pet path (an empty box until it loads). */
function PetTileFace(props: Readonly<{ pet: PetAccountReferenceV1; size: number }>) {
  const empty = <View style={{ width: props.size, height: props.size }} />;
  return <SessionBotFacePet petRef={props.pet} ownFace={empty} size={props.size} mood="quiet" seed={0} motionMode="still" />;
}

/**
 * A shape tile's preview: the face (or an empty slot's +) over a one-line caption. A body cell is too narrow for
 * "Surprise", so the Surprise face is captioned by its shuffle glyph alone; its name stays the tile's label for
 * assistive tech and the section value.
 */
function ShapeTile(props: Readonly<{ glyph?: 'shuffle'; icon?: IconName; label?: string; colour: string; children: React.ReactNode }>) {
  return (
    <View style={styles.shapeCell}>
      {props.children ?? <Icon name={props.icon ?? 'plus'} size={ICON_SIZE.xs} color={props.colour} />}
      {props.glyph ? <Icon name={props.glyph} size={ICON_SIZE.xxs} color={props.colour} /> : null}
      {props.label ? <Text variant="meta" numberOfLines={1} style={styles.shapeLabel}>{props.label}</Text> : null}
    </View>
  );
}

function PickerSection(
  props: Readonly<{ title: string; value: string; children: React.ReactNode }>,
) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text variant="label" emphasis="semiBold" style={styles.sectionTitle}>
          {props.title}
        </Text>
        <Text variant="meta" style={styles.sectionValue} numberOfLines={1}>
          {props.value}
        </Text>
      </View>
      {props.children}
    </View>
  );
}

/** A colour's swatch: its own palette stops, lit from above like the bodies it paints (lab R6 swatches). */
function BotFaceSwatch(
  props: Readonly<{ colour: BotFaceColourId; dark: boolean }>,
) {
  const stops = BOT_FACE_COLOURS[props.colour].stops(
    props.dark ? 'dark' : 'light',
  );
  const css = (at: number) =>
    `rgb(${botFaceGradient(stops, at).map(Math.round).join(',')})`;
  return (
    <LinearGradient
      colors={[css(0.15), css(0.5), css(0.9)]}
      start={{ x: 0.3, y: 0 }}
      end={{ x: 0.7, y: 1 }}
      style={SWATCH_STYLE}
    />
  );
}

/**
 * The chooser anchored to the face that opened it: a floating panel on desktop, the shared sheet on a phone. It
 * mounts nothing while closed.
 */
export function BotFacePicker(
  props: Readonly<{
    open: boolean;
    anchorRef: React.RefObject<View | null>;
    onRequestClose: () => void;
    seed: string;
    face: SessionBotFaceV1 | null;
    onChange: (next: SessionBotFaceV1 | null) => void;
    status?: BotFacePickerStatus;
  }>,
) {
  if (!props.open) return null;
  const panel = (layout: 'panel' | 'sheet') => (
    <BotFacePickerPanel
      seed={props.seed}
      face={props.face}
      onChange={props.onChange}
      status={props.status}
      layout={layout}
      onRequestClose={props.onRequestClose}
    />
  );
  return (
    <Popover
      open
      phonePresentation="sheet"
      accessibilityLabel={t('bots.face.title')}
      anchorRef={props.anchorRef}
      autoFocusOnOpen
      placement="bottom"
      gap={8}
      edgePadding={{ horizontal: 8, vertical: 8 }}
      portal={{
        web: true,
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'start',
      }}
      maxWidthCap={PICKER_WIDTH_PX}
      maxHeightCap={PICKER_MAX_HEIGHT_PX}
      onRequestClose={props.onRequestClose}
    >
      {({ maxHeight, maxWidth, presentation }) =>
        presentation === 'sheet' ? (
          panel('sheet')
        ) : (
          <FloatingOverlay
            maxHeight={Math.min(maxHeight, PICKER_MAX_HEIGHT_PX)}
            surfaceChrome="theme"
            keyboardShouldPersistTaps="always"
            containerStyle={{ width: Math.min(maxWidth, PICKER_WIDTH_PX) }}
          >
            {panel('panel')}
          </FloatingOverlay>
        )
      }
    </Popover>
  );
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    padding: theme.space.s16,
    gap: theme.space.s16,
  },
  section: {
    gap: theme.space.s8,
  },
  cell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  shapeCell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.s2,
  },
  shapeLabel: {
    color: theme.colors.text.secondary,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: theme.space.s12,
  },
  sectionTitle: {
    color: theme.colors.text.primary,
  },
  sectionValue: {
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: theme.space.s16,
    rowGap: theme.space.s8,
    paddingTop: theme.space.s12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.subtle,
  },
  note: {
    flex: 1,
    minWidth: 160,
    color: theme.colors.text.secondary,
  },
  failed: {
    color: theme.colors.state.danger.foreground,
  },
}));
