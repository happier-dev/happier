import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';

import { BUILT_IN_PET_IDS, resolveBuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import { BotFacePet } from '@/components/sessions/bots/face/BotFacePet';
import { useSetting } from '@/sync/domains/state/storage';
import { BotFacePickerPanel } from '@/components/sessions/bots/BotFacePicker';
import type { BotFaceMood } from '@/components/sessions/bots/face/botFaceGeometry';
import { SessionBotFace } from '@/components/sessions/bots/face/SessionBotFace';
import type { SessionBotFaceFacts } from '@/components/sessions/bots/face/sessionBotFaceFacts';
import { Text } from '@/components/ui/text/Text';

/**
 * Dev-only: a pet worn as a Bot's face (lab R11). Sizes and states draw the real pet face renderer (`BotFacePet`) with the
 * built-in atlases, so they render whatever the Account's Pets feature says; the chooser and the fallback go through the
 * real face entry (`SessionBotFace`), which honours it. Sizes are the face spots' own (DECISIONS-R11 §1); states play
 * live on the Bot motion setting. `?only=sizes|states|picker|fallback`.
 */
const SPOT_SIZES = [14, 16, 20, 22, 24, 30, 32, 40, 44] as const;
const STATE_SIZES = [16, 24, 32] as const;
const MOODS: readonly BotFaceMood[] = ['quiet', 'working', 'needsYou', 'done', 'failed'];

const petFacts = (petId: string, seed = `specimen-${petId}`): SessionBotFaceFacts => ({ seed, face: { seed, pet: { kind: 'builtIn', petId } } });
const OWN_FACE: SessionBotFaceFacts = { seed: 'issue-triager', face: { seed: 'issue-triager', style: 'dither' } };
const DELETED_PET: SessionBotFaceFacts = { seed: 'issue-triager', face: { seed: 'issue-triager', style: 'dither', pet: { kind: 'accountPet', accountPetId: 'deleted-pet' } } };

export function PetFaceSpecimen(props: Readonly<{ only: string | null }>) {
  const show = (id: string) => props.only === null || props.only === id;
  return (
    <ScrollView contentContainerStyle={styles.page}>
      {show('sizes') ? (
        <Section title="Every face spot" note="16 rows and notch · 20 Bots entry and window rail · 22 phone row · 24 rail pin · 30 popover · 32 header and Home · 40 New Bot · 44 chooser">
          <View style={styles.grid}>
            {['own', ...BUILT_IN_PET_IDS].map((petId) => (
              <View key={petId} style={styles.row}>
                <Text variant="meta" style={styles.label}>{petId === 'own' ? 'Own face' : petId}</Text>
                {SPOT_SIZES.map((size) => (
                  <View key={size} style={styles.spot}>
                    {petId === 'own' ? <SessionBotFace facts={OWN_FACE} size={size} /> : <PetFace petId={petId} size={size} mood="quiet" />}
                    <Text variant="meta" style={styles.caption}>{size}</Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        </Section>
      ) : null}
      {show('states') ? (
        <Section title="States" note="Rail life (motion), on the Bot motion setting: quiet rests and now and then plays its idle row; working and needs you loop; done and failed play once; hover hops.">
          {STATE_SIZES.map((size) => (
            <View key={size} style={styles.row}>
              <Text variant="meta" style={styles.label}>{size}</Text>
              {MOODS.map((mood) => (
                <View key={mood} style={styles.state}>
                  <PetFace petId="milo" size={size} mood={mood} motion seed={MOODS.indexOf(mood) * 7919} />
                  <Text variant="meta" style={styles.caption}>{mood}</Text>
                </View>
              ))}
            </View>
          ))}
        </Section>
      ) : null}
      {show('picker') ? (
        <Section title="Chooser" note="A pet chosen, then the phone sheet.">
          <View style={styles.pickers}>
            <PickerSpecimen width={560} layout="panel" initial={petFacts('milo').face} />
            <PickerSpecimen width={358} layout="sheet" initial={petFacts('titi').face} />
          </View>
        </Section>
      ) : null}
      {show('fallback') ? (
        <Section title="Fallback" note="A pet this viewer can't read, or a deleted one, shows the Bot's own face.">
          <View style={styles.row}>
            {[16, 24, 32].map((size) => <SessionBotFace key={size} facts={DELETED_PET} size={size} />)}
          </View>
        </Section>
      ) : null}
    </ScrollView>
  );
}

/** The real pet face renderer on a built-in atlas, at the Bot motion setting. */
function PetFace(props: Readonly<{ petId: string; size: number; mood: BotFaceMood; motion?: boolean; seed?: number }>) {
  const pet = resolveBuiltInPetPackage(props.petId);
  const motionMode = useSetting('botMotion');
  return (
    <BotFacePet spritesheetSource={pet.spritesheetSource} opaqueBounds={pet.opaqueBounds} size={props.size}
      mood={props.mood} motion={props.motion} motionMode={motionMode} seed={props.seed ?? 0} />
  );
}

function PickerSpecimen(props: Readonly<{ width: number; layout: 'panel' | 'sheet'; initial: SessionBotFaceV1 | null }>) {
  const [face, setFace] = React.useState(props.initial);
  return (
    <View style={[styles.picker, { width: props.width }]}>
      <BotFacePickerPanel seed={face?.seed ?? 'specimen'} face={face} onChange={setFace} layout={props.layout} />
    </View>
  );
}

function Section(props: Readonly<{ title: string; note: string; children: React.ReactNode }>) {
  return (
    <View style={styles.section}>
      <Text variant="title" emphasis="semiBold" style={styles.title}>{props.title}</Text>
      <Text variant="meta" style={styles.note}>{props.note}</Text>
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  page: { padding: theme.space.s24, gap: theme.space.s32, backgroundColor: theme.colors.surface.base },
  section: { gap: theme.space.s12 },
  title: { color: theme.colors.text.primary },
  note: { color: theme.colors.text.secondary },
  grid: { gap: theme.space.s12 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: theme.space.s16, flexWrap: 'wrap' },
  label: { width: 64, color: theme.colors.text.secondary },
  spot: { alignItems: 'center', gap: theme.space.s4 },
  state: { alignItems: 'center', gap: theme.space.s4, minWidth: 56 },
  caption: { color: theme.colors.text.secondary },
  pickers: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.s24, alignItems: 'flex-start' },
  picker: { borderRadius: theme.borderRadius.lg, borderWidth: 1, borderColor: theme.colors.border.subtle, backgroundColor: theme.colors.surface.elevated },
}));
