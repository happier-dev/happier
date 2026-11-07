import type { SupportedLanguage } from '../_all';

type Count = Readonly<{ count: number }>;
const fill = (text: string) => (values: Readonly<Record<string, string>>) =>
    text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
const plural = (one: string, other: string) => ({ count }: Count) => (count === 1 ? one : other).replace('{count}', String(count));

/** Template page states: empty sections, setup's own copy and Create reason, What's new changes and its consequence. */
function copy(words: Readonly<{
    noFirstTask: string; noFirstTaskHint: string; needsNothing: string; needsNothingHint: string; yourCopy: string;
    checkingWhereItRuns: string; authorsTemplate: string; updateConsequence: string; changedLinesYouEdited: string;
    unchangedLinesOne: string; unchangedLinesOther: string; taken: string;
}>) {
    return {
        noFirstTask: words.noFirstTask, noFirstTaskHint: words.noFirstTaskHint,
        needsNothing: words.needsNothing, needsNothingHint: words.needsNothingHint,
        yourCopy: words.yourCopy, checkingWhereItRuns: words.checkingWhereItRuns,
        authorsTemplate: fill(words.authorsTemplate) as (p: { author: string }) => string,
        updateConsequence: fill(words.updateConsequence) as (p: { name: string; version: string }) => string,
        changedLinesYouEdited: words.changedLinesYouEdited,
        unchangedLines: plural(words.unchangedLinesOne, words.unchangedLinesOther),
        taken: words.taken,
    };
}

export const botTemplatePageTranslations = {
    en: copy({ noFirstTask: 'No first task', noFirstTaskHint: 'Once it’s yours, ask it anything.',
        needsNothing: 'Nothing to install or connect', needsNothingHint: 'No software, sign-ins or MCP servers.',
        yourCopy: 'Your copy', checkingWhereItRuns: 'Checking the Agent on this Machine…',
        authorsTemplate: '{author}’s template', updateConsequence: 'Updates {name} to v{version}. Its memory stays as it is.',
        changedLinesYouEdited: 'Lines you both changed. Choose what your Bot keeps.',
        unchangedLinesOne: '1 change to a line you haven’t edited', unchangedLinesOther: '{count} changes to lines you haven’t edited', taken: 'Taken' }),
    fr: copy({ noFirstTask: 'Aucune première tâche', noFirstTaskHint: 'Une fois à vous, demandez-lui ce que vous voulez.',
        needsNothing: 'Rien à installer ni à connecter', needsNothingHint: 'Aucun logiciel, compte ni serveur MCP.',
        yourCopy: 'Votre copie', checkingWhereItRuns: 'Vérification de l’Agent sur cette machine…',
        authorsTemplate: 'Modèle de {author}', updateConsequence: 'Met {name} à jour vers v{version}. Sa mémoire reste inchangée.',
        changedLinesYouEdited: 'Lignes modifiées des deux côtés. Choisissez ce que votre Bot garde.',
        unchangedLinesOne: '1 modification d’une ligne que vous n’avez pas changée', unchangedLinesOther: '{count} modifications de lignes que vous n’avez pas changées', taken: 'Repris' }),
    de: copy({ noFirstTask: 'Keine erste Aufgabe', noFirstTaskHint: 'Sobald er dir gehört, frag ihn, was du willst.',
        needsNothing: 'Nichts zu installieren oder zu verbinden', needsNothingHint: 'Keine Software, Anmeldungen oder MCP-Server.',
        yourCopy: 'Deine Kopie', checkingWhereItRuns: 'Agent auf dieser Maschine wird geprüft…',
        authorsTemplate: 'Vorlage von {author}', updateConsequence: 'Aktualisiert {name} auf v{version}. Sein Gedächtnis bleibt unverändert.',
        changedLinesYouEdited: 'Zeilen, die ihr beide geändert habt. Wähle, was dein Bot behält.',
        unchangedLinesOne: '1 Änderung an einer Zeile, die du nicht bearbeitet hast', unchangedLinesOther: '{count} Änderungen an Zeilen, die du nicht bearbeitet hast', taken: 'Übernommen' }),
    es: copy({ noFirstTask: 'Sin primera tarea', noFirstTaskHint: 'Cuando sea tuyo, pídele lo que quieras.',
        needsNothing: 'Nada que instalar ni conectar', needsNothingHint: 'Sin software, inicios de sesión ni servidores MCP.',
        yourCopy: 'Tu copia', checkingWhereItRuns: 'Comprobando el Agent en esta máquina…',
        authorsTemplate: 'Plantilla de {author}', updateConsequence: 'Actualiza {name} a v{version}. Su memoria no cambia.',
        changedLinesYouEdited: 'Líneas que ambos cambiasteis. Elige qué conserva tu Bot.',
        unchangedLinesOne: '1 cambio en una línea que no editaste', unchangedLinesOther: '{count} cambios en líneas que no editaste', taken: 'Adoptado' }),
    it: copy({ noFirstTask: 'Nessuna prima attività', noFirstTaskHint: 'Quando è tuo, chiedigli quello che vuoi.',
        needsNothing: 'Niente da installare o collegare', needsNothingHint: 'Nessun software, accesso o server MCP.',
        yourCopy: 'La tua copia', checkingWhereItRuns: 'Verifica dell’Agent su questa macchina…',
        authorsTemplate: 'Modello di {author}', updateConsequence: 'Aggiorna {name} alla v{version}. La sua memoria resta invariata.',
        changedLinesYouEdited: 'Righe modificate da entrambi. Scegli cosa mantiene il tuo Bot.',
        unchangedLinesOne: '1 modifica a una riga che non hai cambiato', unchangedLinesOther: '{count} modifiche a righe che non hai cambiato', taken: 'Adottato' }),
    pt: copy({ noFirstTask: 'Sem primeira tarefa', noFirstTaskHint: 'Quando for teu, pede-lhe o que quiseres.',
        needsNothing: 'Nada para instalar ou ligar', needsNothingHint: 'Sem software, sessões iniciadas ou servidores MCP.',
        yourCopy: 'A tua cópia', checkingWhereItRuns: 'A verificar o Agent nesta máquina…',
        authorsTemplate: 'Modelo de {author}', updateConsequence: 'Atualiza {name} para v{version}. A memória mantém-se.',
        changedLinesYouEdited: 'Linhas que ambos alteraram. Escolhe o que o teu Bot mantém.',
        unchangedLinesOne: '1 alteração numa linha que não editaste', unchangedLinesOther: '{count} alterações em linhas que não editaste', taken: 'Adotado' }),
    ca: copy({ noFirstTask: 'Sense primera tasca', noFirstTaskHint: 'Quan sigui teu, demana-li el que vulguis.',
        needsNothing: 'Res a instal·lar ni a connectar', needsNothingHint: 'Sense programari, inicis de sessió ni servidors MCP.',
        yourCopy: 'La teva còpia', checkingWhereItRuns: 'Comprovant l’Agent en aquesta màquina…',
        authorsTemplate: 'Plantilla de {author}', updateConsequence: 'Actualitza {name} a v{version}. La memòria no canvia.',
        changedLinesYouEdited: 'Línies que heu canviat tots dos. Tria què conserva el teu Bot.',
        unchangedLinesOne: '1 canvi en una línia que no has editat', unchangedLinesOther: '{count} canvis en línies que no has editat', taken: 'Adoptat' }),
    ja: copy({ noFirstTask: '最初のタスクはありません', noFirstTaskHint: '自分のものになったら、何でも頼めます。',
        needsNothing: 'インストールや接続は不要です', needsNothingHint: 'ソフトウェア、サインイン、MCPサーバーは不要です。',
        yourCopy: 'あなたのコピー', checkingWhereItRuns: 'このマシンのAgentを確認しています…',
        authorsTemplate: '{author}のテンプレート', updateConsequence: '{name}をv{version}に更新します。記憶は変わりません。',
        changedLinesYouEdited: '双方が変更した行です。Botに残す内容を選んでください。',
        unchangedLinesOne: '編集していない行への変更 1件', unchangedLinesOther: '編集していない行への変更 {count}件', taken: '取り込み済み' }),
    ru: copy({ noFirstTask: 'Нет первой задачи', noFirstTaskHint: 'Когда он станет вашим, просите о чём угодно.',
        needsNothing: 'Ничего не нужно устанавливать или подключать', needsNothingHint: 'Без программ, входов и MCP-серверов.',
        yourCopy: 'Ваша копия', checkingWhereItRuns: 'Проверяем Agent на этой машине…',
        authorsTemplate: 'Шаблон автора {author}', updateConsequence: 'Обновляет {name} до v{version}. Память не меняется.',
        changedLinesYouEdited: 'Строки, которые изменили вы оба. Выберите, что оставит ваш бот.',
        unchangedLinesOne: '1 изменение в строке, которую вы не правили', unchangedLinesOther: 'Изменений в строках, которые вы не правили: {count}', taken: 'Принято' }),
    pl: copy({ noFirstTask: 'Brak pierwszego zadania', noFirstTaskHint: 'Gdy będzie twój, poproś go o cokolwiek.',
        needsNothing: 'Nic do zainstalowania ani połączenia', needsNothingHint: 'Bez oprogramowania, logowań i serwerów MCP.',
        yourCopy: 'Twoja kopia', checkingWhereItRuns: 'Sprawdzanie Agenta na tej maszynie…',
        authorsTemplate: 'Szablon: {author}', updateConsequence: 'Aktualizuje {name} do v{version}. Pamięć pozostaje bez zmian.',
        changedLinesYouEdited: 'Wiersze zmienione przez was oboje. Wybierz, co zachowa twój bot.',
        unchangedLinesOne: '1 zmiana w wierszu, którego nie edytowano', unchangedLinesOther: 'Zmiany w wierszach, których nie edytowano: {count}', taken: 'Przyjęto' }),
    'zh-Hans': copy({ noFirstTask: '没有首个任务', noFirstTaskHint: '成为你的之后，可以随意提问。',
        needsNothing: '无需安装或连接', needsNothingHint: '不需要软件、登录或 MCP 服务器。',
        yourCopy: '你的副本', checkingWhereItRuns: '正在检查此机器上的 Agent…',
        authorsTemplate: '{author}的模板', updateConsequence: '将{name}更新到 v{version}。记忆保持不变。',
        changedLinesYouEdited: '双方都修改过的行。选择你的 Bot 保留什么。',
        unchangedLinesOne: '你未编辑的行有 1 处更改', unchangedLinesOther: '你未编辑的行有 {count} 处更改', taken: '已采用' }),
    'zh-Hant': copy({ noFirstTask: '沒有首個任務', noFirstTaskHint: '成為你的之後，可以隨意提問。',
        needsNothing: '無需安裝或連接', needsNothingHint: '不需要軟體、登入或 MCP 伺服器。',
        yourCopy: '你的副本', checkingWhereItRuns: '正在檢查此機器上的 Agent…',
        authorsTemplate: '{author}的範本', updateConsequence: '將{name}更新到 v{version}。記憶保持不變。',
        changedLinesYouEdited: '雙方都修改過的行。選擇你的 Bot 保留什麼。',
        unchangedLinesOne: '你未編輯的行有 1 處變更', unchangedLinesOther: '你未編輯的行有 {count} 處變更', taken: '已採用' }),
} satisfies Record<SupportedLanguage, ReturnType<typeof copy>>;
