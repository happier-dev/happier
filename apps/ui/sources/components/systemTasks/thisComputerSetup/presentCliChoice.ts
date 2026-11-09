import type { SetupCliChoice } from '@happier-dev/protocol/system/tasks/promptPayloadContracts';

import { Modal } from '@/modal';
import { t } from '@/text';

import type { CliChoiceSetupPrompt } from './resolveThisComputerSetupPrompt';

/**
 * R12's one question, asked when setup finds a `happier` this app did not install: let Happier
 * manage the command line (install its own, put it first on PATH, move the background service to
 * it) or keep the person's own. It names the version and the path, because those are what the
 * person recognises. `null` means no answer (dismissed, or "Not now"): nothing is recorded and the
 * run stops before it writes anything.
 */
export async function presentCliChoice(prompt: CliChoiceSetupPrompt): Promise<SetupCliChoice | null> {
    let answer: SetupCliChoice | null = null;
    // A kept CLI that disappeared is asked about by the path it was at.
    const title = prompt.missing
        ? t('machine.thisComputer.cliChoice.titleMissing')
        : prompt.version
            ? t('machine.thisComputer.cliChoice.title', { version: prompt.version })
            : t('machine.thisComputer.cliChoice.titleUnknownVersion');
    // When a managed `happier` Happier did not add answers first in new terminals, keeping this one
    // could not make the terminal run it, so Keep is not offered; the body names what is in the way.
    const keepBlockedBy = prompt.keepBlockedBy;
    const body = keepBlockedBy
        ? t('machine.thisComputer.cliChoice.bodyKeepBlocked', { path: prompt.command, link: keepBlockedBy })
        : prompt.missing
            ? t('machine.thisComputer.cliChoice.bodyMissing', { path: prompt.command })
            : prompt.belowSetupFloor
                ? t('machine.thisComputer.cliChoice.bodyOutdated', { path: prompt.command })
                : t('machine.thisComputer.cliChoice.body', { path: prompt.command });
    await Modal.alertAsync(title, body, [
        keepBlockedBy
            ? { text: t('machine.thisComputer.cliChoice.notNow'), style: 'cancel' }
            : { text: t('machine.thisComputer.cliChoice.keep'), style: 'cancel', onPress: () => { answer = 'own'; } },
        { text: t('machine.thisComputer.cliChoice.manage'), onPress: () => { answer = 'managed'; } },
    ]);
    return answer;
}
