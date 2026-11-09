import * as React from 'react';
import { View } from 'react-native';
import { SkillMachineInstallResultV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import {
  ExpandableItem,
} from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import type { UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';

import { readSkillActionRefusal } from './useSkillDetail';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

type Execute = (
  actionId: 'skills.machine.install' | 'skills.machine.uninstall',
  input: unknown,
  operation?: UiActionOperation,
) => Promise<ActionExecuteResult>;

/**
 * "Details" (sd D, closed by default): the revision, and "Also install on <machine>" for each online
 * machine (P3 `skills.machine.install/uninstall`; D1: for use outside Happier). First-party skills offer
 * no install rows (bundled content would drift from the installed Happier).
 */
export function SkillDetailsDisclosure(
  props: Readonly<{
    skillId: string;
    revision: string;
    onlineMachines: readonly Readonly<{ machineId: string; name: string }>[];
    allowInstall: boolean;
    /** Paths of Happier's copies, per machine, as the last Found scan read them (the receipts' truth). */
    installedPaths?: Readonly<Record<string, readonly string[]>>;
    execute: Execute;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  // What this page itself just did on a machine wins over the last scan until the next scan lands.
  const [changed, setChanged] = React.useState<Readonly<Record<string, readonly string[]>>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const pathsOf = (machineId: string): readonly string[] =>
    changed[machineId] ?? props.installedPaths?.[machineId] ?? NO_PATHS;

  const setPaths = (machineId: string, paths: readonly string[]) =>
    setChanged((current) => ({ ...current, [machineId]: paths }));

  const install = async (machine: Readonly<{ machineId: string; name: string }>) => {
    const result = await props.execute('skills.machine.install', {
      skillId: props.skillId,
      machineId: machine.machineId,
    });
    if (result.ok) {
      const parsed = SkillMachineInstallResultV1Schema.safeParse(result.result);
      setPaths(machine.machineId, parsed.success ? parsed.data.receipts.map((receipt) => receipt.path) : []);
      return;
    }
    // A partial install keeps the copies it did write: the receipts say where.
    const written = readReceiptPaths(result.details);
    if (written.length > 0) setPaths(machine.machineId, written);
    const code = readSkillActionRefusal(result);
    Modal.alert(
      t('common.error'),
      code === 'externally_modified'
        ? t('capabilities.skillsFound.install.externallyModified', { machine: machine.name })
        : code === 'native_conflict'
          ? t('capabilities.skillsFound.install.nativeConflict', { machine: machine.name })
          : written.length > 0
            ? t('capabilities.skillsFound.install.partial', { machine: machine.name })
            : t('capabilities.skillsFound.install.failed', { machine: machine.name }),
    );
  };

  const uninstall = async (
    machine: Readonly<{ machineId: string; name: string }>,
    force: boolean,
  ) => {
    const confirmed = await Modal.confirm(
      t('capabilities.skillsFound.install.removeTitle', { machine: machine.name }),
      force
        ? t('capabilities.skillsFound.install.externallyModified', { machine: machine.name })
        : t('capabilities.skillsFound.install.removeBody'),
      {
        confirmText: force
          ? t('capabilities.skillsFound.install.removeAnyway')
          : t('capabilities.skillsFound.install.remove'),
        destructive: true,
      },
    );
    if (!confirmed) return;
    const result = await props.execute(
      'skills.machine.uninstall',
      { skillId: props.skillId, machineId: machine.machineId, ...(force ? { force: true } : {}) },
      { confirmed: true },
    );
    if (result.ok) {
      setPaths(machine.machineId, []);
      return;
    }
    // A copy edited outside Happier is never deleted silently: ask again, naming that.
    if (readSkillActionRefusal(result) === 'externally_modified' && !force) {
      await uninstall(machine, true);
      return;
    }
    Modal.alert(
      t('common.error'),
      t('capabilities.skillsFound.install.removeFailed', { machine: machine.name }),
    );
  };

  const toggle = async (machine: Readonly<{ machineId: string; name: string }>) => {
    setBusy(machine.machineId);
    try {
      if (pathsOf(machine.machineId).length > 0) await uninstall(machine, false);
      else await install(machine);
    } finally {
      setBusy(null);
    }
  };

  return (
    <ItemGroup header="none" testID={props.testID}>
      <ExpandableItem
        testID={`${props.testID}:disclosure`}
        expanded={open}
        onExpandedChange={setOpen}
        showDivider={false}
        header={({ headerProps, expanded }) => (
          <Item
            {...(headerProps as Readonly<Record<string, unknown>>)}
            testID={`${props.testID}:header`}
            title={t('capabilities.skillDetail.details.title')}
            keepChevronWithRightElement
            rightElement={
              expanded ? null : (
                <Text variant="meta" style={styles.summary}>
                  {t('capabilities.skillDetail.details.summary')}
                </Text>
              )
            }
          />
        )}
      >
        {open ? (
          <>
            <Item
              testID={`${props.testID}:revision`}
              title={t('capabilities.skillDetail.details.revision')}
              rightElement={
                <Text
                  variant="meta"
                  style={styles.mono}
                  selectable
                  numberOfLines={1}
                >
                  {props.revision}
                </Text>
              }
              showChevron={false}
            />
            {props.allowInstall
              ? props.onlineMachines.map((machine) => {
                  const paths = pathsOf(machine.machineId);
                  const isInstalled = paths.length > 0;
                  return (
                    <Item
                      key={machine.machineId}
                      testID={`${props.testID}:install:${machine.machineId}`}
                      title={t('capabilities.skillDetail.details.alsoInstall', {
                        machine: machine.name,
                      })}
                      subtitle={
                        isInstalled ? (
                          <View style={styles.receipts}>
                            {paths.map((path) => (
                              <Text
                                key={path}
                                variant="meta"
                                style={styles.receipt}
                                numberOfLines={1}
                                testID={`${props.testID}:receipt:${machine.machineId}`}
                              >
                                {t('capabilities.skillsFound.install.installedIn', { path })}
                              </Text>
                            ))}
                          </View>
                        ) : (
                          t('capabilities.skillDetail.details.alsoInstallBody')
                        )
                      }
                      icon={
                        <Icon
                          name="desktop"
                          size={20}
                          color={theme.colors.text.secondary}
                        />
                      }
                      rightElement={
                        <RoundButton
                          testID={`${props.testID}:toggle:${machine.machineId}`}
                          size="small"
                          display="secondary"
                          loading={busy === machine.machineId}
                          disabled={busy !== null}
                          title={
                            isInstalled
                              ? t('capabilities.skillDetail.files.remove')
                              : t('capabilities.skillDetail.details.install')
                          }
                          onPress={() => {
                            void toggle(machine);
                          }}
                        />
                      }
                      showChevron={false}
                    />
                  );
                })
              : null}
          </>
        ) : null}
      </ExpandableItem>
    </ItemGroup>
  );
}

const NO_PATHS: readonly string[] = Object.freeze([]);

/** Receipt paths a refused machine Action still acknowledged (`details.receipts`). */
function readReceiptPaths(details: unknown): readonly string[] {
  const receipts =
    details && typeof details === 'object' ? Reflect.get(details, 'receipts') : undefined;
  if (!Array.isArray(receipts)) return NO_PATHS;
  return receipts.flatMap((receipt: unknown) => {
    const path =
      receipt && typeof receipt === 'object' ? Reflect.get(receipt, 'path') : undefined;
    return typeof path === 'string' ? [path] : [];
  });
}

const styles = StyleSheet.create((theme) => ({
  receipts: { gap: theme.space.s2 },
  receipt: { ...Typography.mono(), color: theme.colors.text.secondary },
  summary: { color: theme.colors.text.secondary },
  mono: {
    ...Typography.mono(),
    color: theme.colors.text.secondary,
    maxWidth: 260,
  },
}));
