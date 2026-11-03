import type { SupportedLanguage } from '../_all';

type Count = { count: number };
type Words = Readonly<{
  draftKind: string;
  whatPeopleGet: string;
  getsInstructions: string;
  getsMemory: (p: Count) => string;
  getsSkills: (p: Count) => string;
  getsNeeds: (p: Count) => string;
  leftOutMemory: (p: Count) => string;
  leftOutSkills: (p: Count) => string;
  leftOutConversations: string;
  leftOutMachines: string;
  nothingShared: string;
  reviewShort: string;
  whatItDoes: string;
  tryItWith: string;
  firstTaskHint: string;
  whatItNeeds: string;
  needsChecked: string;
  kindSoftware: string;
  kindAccount: string;
  kindMcp: string;
  whatYouGet: string;
  yourOwnBot: string;
  asideInstructions: string;
  asideGeneralCopy: string;
  asideMemory: (p: Count) => string;
  asideSkills: (p: Count) => string;
  notIncluded: string;
  makeOwnEllipsis: string;
  shareEllipsis: string;
  publishEllipsis: string;
  savedAsYouEdit: string;
  whereItRuns: string;
  templateSection: string;
  templateSectionDescription: (p: { name: string }) => string;
  namedTemplate: (p: { name: string }) => string;
  giveCopyEllipsis: string;
}>;

const named = (text: string) => ({ name }: { name: string }) => text.replace('{name}', () => name);
const n =
  (one: string, other: string) =>
  ({ count }: Count) =>
    (count === 1 ? one : other).replace('{count}', String(count));

/** Bot template card, preview and summary copy (round-2 lab language). */
export const botTemplatePresentationTranslations = {
  en: {
    draftKind: 'Bot template · private draft',
    whatPeopleGet: 'What people get',
    getsInstructions: 'Its instructions, as a general copy',
    getsMemory: n('1 rule from its memory', '{count} rules from its memory'),
    getsSkills: n('1 skill', '{count} skills'),
    getsNeeds: n('Needs 1 tool or sign-in', 'Needs {count} tools or sign-ins'),
    leftOutMemory: n(
      '1 memory it keeps to itself',
      '{count} memories it keeps to itself',
    ),
    leftOutSkills: n('1 private skill', '{count} private skills'),
    leftOutConversations: 'Conversations and files',
    leftOutMachines: 'Machines and sign-ins',
    nothingShared: 'Nothing is shared until you review it.',
    reviewShort: 'Review',
    whatItDoes: 'What it does',
    tryItWith: 'Try it with',
    firstTaskHint: 'Its first task, one tap away once it’s yours.',
    whatItNeeds: 'What it needs',
    needsChecked:
      'Checked against your Machine when you make your own. No keys or sign-ins come with it; you connect your own.',
    kindSoftware: 'Software',
    kindAccount: 'Account',
    kindMcp: 'MCP server',
    whatYouGet: 'What you get',
    yourOwnBot: 'Your own Bot · yours to change',
    asideInstructions: 'Instructions',
    asideGeneralCopy: 'a general copy',
    asideMemory: n(
      '1 rule from how it works',
      '{count} rules from how it works',
    ),
    asideSkills: n('1 skill', '{count} skills'),
    notIncluded:
      'Not included: the author’s memory, conversations and files, Machines and sign-ins.',
    makeOwnEllipsis: 'Make my own…',
    shareEllipsis: 'Share…', publishEllipsis: 'Publish…', savedAsYouEdit: 'Private draft · saved as you edit',
    whereItRuns: 'Where it runs',
    templateSection: 'Template', templateSectionDescription: named('What others start their own {name} from.'), namedTemplate: named('{name} template'), giveCopyEllipsis: 'Give a copy…',
  },
  fr: {
    draftKind: 'Modèle de Bot · brouillon privé',
    whatPeopleGet: 'Ce que les autres reçoivent',
    getsInstructions: 'Ses instructions, en copie générale',
    getsMemory: n('1 règle de sa mémoire', '{count} règles de sa mémoire'),
    getsSkills: n('1 compétence', '{count} compétences'),
    getsNeeds: n(
      'Demande 1 outil ou connexion',
      'Demande {count} outils ou connexions',
    ),
    leftOutMemory: n(
      '1 souvenir qu’il garde pour lui',
      '{count} souvenirs qu’il garde pour lui',
    ),
    leftOutSkills: n('1 compétence privée', '{count} compétences privées'),
    leftOutConversations: 'Conversations et fichiers',
    leftOutMachines: 'Machines et connexions',
    nothingShared: 'Rien n’est partagé avant votre vérification.',
    reviewShort: 'Vérifier',
    whatItDoes: 'Ce qu’il fait',
    tryItWith: 'Essayez avec',
    firstTaskHint:
      'Sa première tâche, à portée de main une fois qu’il est à vous.',
    whatItNeeds: 'Ce qu’il lui faut',
    needsChecked:
      'Vérifié sur votre machine quand vous créez votre copie. Aucune clé ni connexion n’est incluse ; vous connectez les vôtres.',
    kindSoftware: 'Logiciel',
    kindAccount: 'Compte',
    kindMcp: 'Serveur MCP',
    whatYouGet: 'Ce que vous recevez',
    yourOwnBot: 'Votre propre Bot · modifiable à volonté',
    asideInstructions: 'Instructions',
    asideGeneralCopy: 'une copie générale',
    asideMemory: n(
      '1 règle sur sa façon de travailler',
      '{count} règles sur sa façon de travailler',
    ),
    asideSkills: n('1 compétence', '{count} compétences'),
    notIncluded:
      'Non inclus : la mémoire, les conversations et fichiers, les machines et connexions de l’auteur.',
    makeOwnEllipsis: 'Créer ma copie…',
    shareEllipsis: 'Partager…', publishEllipsis: 'Publier…', savedAsYouEdit: 'Brouillon privé · enregistré au fil de l’eau',
    whereItRuns: 'Où il s’exécute',
    templateSection: 'Modèle', templateSectionDescription: named('Ce à partir de quoi les autres créent leur propre {name}.'), namedTemplate: named('Modèle {name}'), giveCopyEllipsis: 'Donner une copie…',
  },
  de: {
    draftKind: 'Bot-Vorlage · privater Entwurf',
    whatPeopleGet: 'Was andere bekommen',
    getsInstructions: 'Seine Anweisungen, als allgemeine Kopie',
    getsMemory: n(
      '1 Regel aus seinem Gedächtnis',
      '{count} Regeln aus seinem Gedächtnis',
    ),
    getsSkills: n('1 Fähigkeit', '{count} Fähigkeiten'),
    getsNeeds: n(
      'Braucht 1 Werkzeug oder Anmeldung',
      'Braucht {count} Werkzeuge oder Anmeldungen',
    ),
    leftOutMemory: n(
      '1 Erinnerung, die es für sich behält',
      '{count} Erinnerungen, die es für sich behält',
    ),
    leftOutSkills: n('1 private Fähigkeit', '{count} private Fähigkeiten'),
    leftOutConversations: 'Unterhaltungen und Dateien',
    leftOutMachines: 'Rechner und Anmeldungen',
    nothingShared: 'Nichts wird geteilt, bevor du es prüfst.',
    reviewShort: 'Prüfen',
    whatItDoes: 'Was es tut',
    tryItWith: 'Probier es mit',
    firstTaskHint:
      'Seine erste Aufgabe, einen Tipp entfernt, sobald es dir gehört.',
    whatItNeeds: 'Was es braucht',
    needsChecked:
      'Wird beim Erstellen deiner Kopie mit deinem Rechner abgeglichen. Schlüssel und Anmeldungen kommen nicht mit; du verbindest deine eigenen.',
    kindSoftware: 'Software',
    kindAccount: 'Konto',
    kindMcp: 'MCP-Server',
    whatYouGet: 'Was du bekommst',
    yourOwnBot: 'Dein eigener Bot · frei änderbar',
    asideInstructions: 'Anweisungen',
    asideGeneralCopy: 'eine allgemeine Kopie',
    asideMemory: n(
      '1 Regel zur Arbeitsweise',
      '{count} Regeln zur Arbeitsweise',
    ),
    asideSkills: n('1 Fähigkeit', '{count} Fähigkeiten'),
    notIncluded:
      'Nicht enthalten: Gedächtnis, Unterhaltungen und Dateien, Rechner und Anmeldungen der Autorin oder des Autors.',
    makeOwnEllipsis: 'Eigene Kopie…',
    shareEllipsis: 'Teilen…', publishEllipsis: 'Veröffentlichen…', savedAsYouEdit: 'Privater Entwurf · wird beim Bearbeiten gespeichert',
    whereItRuns: 'Wo es läuft',
    templateSection: 'Vorlage', templateSectionDescription: named('Woraus andere ihren eigenen {name} starten.'), namedTemplate: named('Vorlage {name}'), giveCopyEllipsis: 'Kopie weitergeben…',
  },
  es: {
    draftKind: 'Plantilla de Bot · borrador privado',
    whatPeopleGet: 'Qué reciben los demás',
    getsInstructions: 'Sus instrucciones, como copia general',
    getsMemory: n('1 regla de su memoria', '{count} reglas de su memoria'),
    getsSkills: n('1 habilidad', '{count} habilidades'),
    getsNeeds: n(
      'Necesita 1 herramienta o cuenta',
      'Necesita {count} herramientas o cuentas',
    ),
    leftOutMemory: n(
      '1 recuerdo que se guarda',
      '{count} recuerdos que se guarda',
    ),
    leftOutSkills: n('1 habilidad privada', '{count} habilidades privadas'),
    leftOutConversations: 'Conversaciones y archivos',
    leftOutMachines: 'Máquinas y cuentas',
    nothingShared: 'No se comparte nada hasta que lo revises.',
    reviewShort: 'Revisar',
    whatItDoes: 'Qué hace',
    tryItWith: 'Pruébalo con',
    firstTaskHint: 'Su primera tarea, a un toque cuando sea tuyo.',
    whatItNeeds: 'Qué necesita',
    needsChecked:
      'Se comprueba en tu máquina al crear tu copia. No incluye claves ni cuentas; conectas las tuyas.',
    kindSoftware: 'Software',
    kindAccount: 'Cuenta',
    kindMcp: 'Servidor MCP',
    whatYouGet: 'Qué recibes',
    yourOwnBot: 'Tu propio Bot · puedes cambiarlo',
    asideInstructions: 'Instrucciones',
    asideGeneralCopy: 'una copia general',
    asideMemory: n('1 regla de cómo trabaja', '{count} reglas de cómo trabaja'),
    asideSkills: n('1 habilidad', '{count} habilidades'),
    notIncluded:
      'No incluye: la memoria, las conversaciones y archivos, las máquinas y cuentas del autor.',
    makeOwnEllipsis: 'Crear el mío…',
    shareEllipsis: 'Compartir…', publishEllipsis: 'Publicar…', savedAsYouEdit: 'Borrador privado · se guarda mientras editas',
    whereItRuns: 'Dónde se ejecuta',
    templateSection: 'Plantilla', templateSectionDescription: named('De dónde otros crean su propio {name}.'), namedTemplate: named('Plantilla de {name}'), giveCopyEllipsis: 'Dar una copia…',
  },
  it: {
    draftKind: 'Modello di Bot · bozza privata',
    whatPeopleGet: 'Cosa ricevono gli altri',
    getsInstructions: 'Le sue istruzioni, come copia generale',
    getsMemory: n(
      '1 regola dalla sua memoria',
      '{count} regole dalla sua memoria',
    ),
    getsSkills: n('1 competenza', '{count} competenze'),
    getsNeeds: n(
      'Richiede 1 strumento o accesso',
      'Richiede {count} strumenti o accessi',
    ),
    leftOutMemory: n(
      '1 ricordo che tiene per sé',
      '{count} ricordi che tiene per sé',
    ),
    leftOutSkills: n('1 competenza privata', '{count} competenze private'),
    leftOutConversations: 'Conversazioni e file',
    leftOutMachines: 'Macchine e accessi',
    nothingShared: 'Nulla viene condiviso finché non lo rivedi.',
    reviewShort: 'Rivedi',
    whatItDoes: 'Cosa fa',
    tryItWith: 'Provalo con',
    firstTaskHint: 'Il suo primo compito, a un tocco quando sarà tuo.',
    whatItNeeds: 'Cosa serve',
    needsChecked:
      'Verificato sulla tua macchina quando crei la tua copia. Non include chiavi né accessi; colleghi i tuoi.',
    kindSoftware: 'Software',
    kindAccount: 'Account',
    kindMcp: 'Server MCP',
    whatYouGet: 'Cosa ricevi',
    yourOwnBot: 'Il tuo Bot · puoi cambiarlo',
    asideInstructions: 'Istruzioni',
    asideGeneralCopy: 'una copia generale',
    asideMemory: n('1 regola su come lavora', '{count} regole su come lavora'),
    asideSkills: n('1 competenza', '{count} competenze'),
    notIncluded:
      'Non incluso: memoria, conversazioni e file, macchine e accessi dell’autore.',
    makeOwnEllipsis: 'Crea il mio…',
    shareEllipsis: 'Condividi…', publishEllipsis: 'Pubblica…', savedAsYouEdit: 'Bozza privata · salvata mentre modifichi',
    whereItRuns: 'Dove gira',
    templateSection: 'Modello', templateSectionDescription: named('Da cui altri creano il proprio {name}.'), namedTemplate: named('Modello {name}'), giveCopyEllipsis: 'Dai una copia…',
  },
  pt: {
    draftKind: 'Modelo de Bot · rascunho privado',
    whatPeopleGet: 'O que os outros recebem',
    getsInstructions: 'As instruções, como cópia geral',
    getsMemory: n('1 regra da sua memória', '{count} regras da sua memória'),
    getsSkills: n('1 competência', '{count} competências'),
    getsNeeds: n(
      'Precisa de 1 ferramenta ou conta',
      'Precisa de {count} ferramentas ou contas',
    ),
    leftOutMemory: n(
      '1 memória que guarda para si',
      '{count} memórias que guarda para si',
    ),
    leftOutSkills: n('1 competência privada', '{count} competências privadas'),
    leftOutConversations: 'Conversas e ficheiros',
    leftOutMachines: 'Máquinas e contas',
    nothingShared: 'Nada é partilhado até reveres.',
    reviewShort: 'Rever',
    whatItDoes: 'O que faz',
    tryItWith: 'Experimenta com',
    firstTaskHint: 'A primeira tarefa, a um toque quando for teu.',
    whatItNeeds: 'Do que precisa',
    needsChecked:
      'Verificado na tua máquina quando crias a tua cópia. Não inclui chaves nem contas; ligas as tuas.',
    kindSoftware: 'Software',
    kindAccount: 'Conta',
    kindMcp: 'Servidor MCP',
    whatYouGet: 'O que recebes',
    yourOwnBot: 'O teu próprio Bot · podes alterá-lo',
    asideInstructions: 'Instruções',
    asideGeneralCopy: 'uma cópia geral',
    asideMemory: n(
      '1 regra de como trabalha',
      '{count} regras de como trabalha',
    ),
    asideSkills: n('1 competência', '{count} competências'),
    notIncluded:
      'Não incluído: a memória, as conversas e ficheiros, as máquinas e contas do autor.',
    makeOwnEllipsis: 'Criar o meu…',
    shareEllipsis: 'Partilhar…', publishEllipsis: 'Publicar…', savedAsYouEdit: 'Rascunho privado · guardado enquanto editas',
    whereItRuns: 'Onde corre',
    templateSection: 'Modelo', templateSectionDescription: named('A partir do qual outros criam o seu próprio {name}.'), namedTemplate: named('Modelo {name}'), giveCopyEllipsis: 'Dar uma cópia…',
  },
  ca: {
    draftKind: 'Plantilla de Bot · esborrany privat',
    whatPeopleGet: 'Què reben els altres',
    getsInstructions: 'Les seves instruccions, com a còpia general',
    getsMemory: n(
      '1 regla de la seva memòria',
      '{count} regles de la seva memòria',
    ),
    getsSkills: n('1 habilitat', '{count} habilitats'),
    getsNeeds: n(
      'Necessita 1 eina o compte',
      'Necessita {count} eines o comptes',
    ),
    leftOutMemory: n('1 record que es guarda', '{count} records que es guarda'),
    leftOutSkills: n('1 habilitat privada', '{count} habilitats privades'),
    leftOutConversations: 'Converses i fitxers',
    leftOutMachines: 'Màquines i comptes',
    nothingShared: 'No es comparteix res fins que ho revisis.',
    reviewShort: 'Revisa',
    whatItDoes: 'Què fa',
    tryItWith: 'Prova-ho amb',
    firstTaskHint: 'La seva primera tasca, a un toc quan sigui teu.',
    whatItNeeds: 'Què necessita',
    needsChecked:
      'Es comprova a la teva màquina quan crees la teva còpia. No inclou claus ni comptes; connectes els teus.',
    kindSoftware: 'Programari',
    kindAccount: 'Compte',
    kindMcp: 'Servidor MCP',
    whatYouGet: 'Què reps',
    yourOwnBot: 'El teu propi Bot · pots canviar-lo',
    asideInstructions: 'Instruccions',
    asideGeneralCopy: 'una còpia general',
    asideMemory: n('1 regla de com treballa', '{count} regles de com treballa'),
    asideSkills: n('1 habilitat', '{count} habilitats'),
    notIncluded:
      'No inclou: la memòria, les converses i fitxers, les màquines i comptes de l’autor.',
    makeOwnEllipsis: 'Crea el meu…',
    shareEllipsis: 'Comparteix…', publishEllipsis: 'Publica…', savedAsYouEdit: 'Esborrany privat · es desa mentre edites',
    whereItRuns: 'On s’executa',
    templateSection: 'Plantilla', templateSectionDescription: named('D’on altres creen el seu propi {name}.'), namedTemplate: named('Plantilla de {name}'), giveCopyEllipsis: 'Dona una còpia…',
  },
  ja: {
    draftKind: 'Botテンプレート · 非公開の下書き',
    whatPeopleGet: '受け取る人に渡るもの',
    getsInstructions: '指示（汎用コピー）',
    getsMemory: n('記憶からのルール 1件', '記憶からのルール {count}件'),
    getsSkills: n('スキル 1件', 'スキル {count}件'),
    getsNeeds: n(
      '必要なツールまたはサインイン 1件',
      '必要なツールまたはサインイン {count}件',
    ),
    leftOutMemory: n('自分だけの記憶 1件', '自分だけの記憶 {count}件'),
    leftOutSkills: n('非公開スキル 1件', '非公開スキル {count}件'),
    leftOutConversations: '会話とファイル',
    leftOutMachines: 'マシンとサインイン',
    nothingShared: '確認するまで何も共有されません。',
    reviewShort: '確認',
    whatItDoes: 'できること',
    tryItWith: '試してみる',
    firstTaskHint: '自分のものになれば、最初のタスクはワンタップです。',
    whatItNeeds: '必要なもの',
    needsChecked:
      '自分のコピーを作るときにマシンで確認されます。キーやサインインは含まれず、自分のものを接続します。',
    kindSoftware: 'ソフトウェア',
    kindAccount: 'アカウント',
    kindMcp: 'MCPサーバー',
    whatYouGet: '受け取るもの',
    yourOwnBot: '自分のBot · 自由に変更できます',
    asideInstructions: '指示',
    asideGeneralCopy: '汎用コピー',
    asideMemory: n('働き方のルール 1件', '働き方のルール {count}件'),
    asideSkills: n('スキル 1件', 'スキル {count}件'),
    notIncluded:
      '含まれないもの：作成者の記憶、会話とファイル、マシンとサインイン。',
    makeOwnEllipsis: '自分用に作成…',
    shareEllipsis: '共有…', publishEllipsis: '公開…', savedAsYouEdit: '非公開の下書き · 編集と同時に保存',
    whereItRuns: '実行する場所',
    templateSection: 'テンプレート', templateSectionDescription: named('他の人が自分の{name}を作るもとになります。'), namedTemplate: named('{name}のテンプレート'), giveCopyEllipsis: 'コピーを渡す…',
  },
  ru: {
    draftKind: 'Шаблон бота · личный черновик',
    whatPeopleGet: 'Что получат другие',
    getsInstructions: 'Его инструкции, в общей копии',
    getsMemory: n('Правил из памяти: 1', 'Правил из памяти: {count}'),
    getsSkills: n('Навыков: 1', 'Навыков: {count}'),
    getsNeeds: n(
      'Нужно инструментов или входов: 1',
      'Нужно инструментов или входов: {count}',
    ),
    leftOutMemory: n('Личных воспоминаний: 1', 'Личных воспоминаний: {count}'),
    leftOutSkills: n('Закрытых навыков: 1', 'Закрытых навыков: {count}'),
    leftOutConversations: 'Разговоры и файлы',
    leftOutMachines: 'Компьютеры и входы',
    nothingShared: 'Ничего не передаётся, пока вы не проверите.',
    reviewShort: 'Проверить',
    whatItDoes: 'Что он делает',
    tryItWith: 'Попробуйте',
    firstTaskHint: 'Первая задача — в одно касание, когда он станет вашим.',
    whatItNeeds: 'Что нужно',
    needsChecked:
      'Проверяется на вашем компьютере при создании копии. Ключи и входы не передаются; вы подключаете свои.',
    kindSoftware: 'Программа',
    kindAccount: 'Аккаунт',
    kindMcp: 'MCP-сервер',
    whatYouGet: 'Что вы получите',
    yourOwnBot: 'Ваш собственный бот · можно менять',
    asideInstructions: 'Инструкции',
    asideGeneralCopy: 'общая копия',
    asideMemory: n('Правил работы: 1', 'Правил работы: {count}'),
    asideSkills: n('Навыков: 1', 'Навыков: {count}'),
    notIncluded:
      'Не входит: память автора, разговоры и файлы, компьютеры и входы.',
    makeOwnEllipsis: 'Сделать свой…',
    shareEllipsis: 'Поделиться…', publishEllipsis: 'Опубликовать…', savedAsYouEdit: 'Личный черновик · сохраняется по ходу правки',
    whereItRuns: 'Где он работает',
    templateSection: 'Шаблон', templateSectionDescription: named('Из него другие создают своего {name}.'), namedTemplate: named('Шаблон «{name}»'), giveCopyEllipsis: 'Дать копию…',
  },
  pl: {
    draftKind: 'Szablon bota · prywatny szkic',
    whatPeopleGet: 'Co otrzymają inni',
    getsInstructions: 'Jego instrukcje, jako kopia ogólna',
    getsMemory: n('Reguły z pamięci: 1', 'Reguły z pamięci: {count}'),
    getsSkills: n('Umiejętności: 1', 'Umiejętności: {count}'),
    getsNeeds: n(
      'Potrzebne narzędzia lub logowania: 1',
      'Potrzebne narzędzia lub logowania: {count}',
    ),
    leftOutMemory: n(
      'Osobiste wspomnienia: 1',
      'Osobiste wspomnienia: {count}',
    ),
    leftOutSkills: n(
      'Prywatne umiejętności: 1',
      'Prywatne umiejętności: {count}',
    ),
    leftOutConversations: 'Rozmowy i pliki',
    leftOutMachines: 'Komputery i logowania',
    nothingShared: 'Nic nie jest udostępniane, dopóki tego nie sprawdzisz.',
    reviewShort: 'Sprawdź',
    whatItDoes: 'Co robi',
    tryItWith: 'Wypróbuj z',
    firstTaskHint: 'Jego pierwsze zadanie, jedno dotknięcie, gdy będzie twój.',
    whatItNeeds: 'Czego potrzebuje',
    needsChecked:
      'Sprawdzane na twoim komputerze przy tworzeniu kopii. Klucze i logowania nie są dołączone; łączysz własne.',
    kindSoftware: 'Oprogramowanie',
    kindAccount: 'Konto',
    kindMcp: 'Serwer MCP',
    whatYouGet: 'Co otrzymasz',
    yourOwnBot: 'Twój własny bot · możesz go zmieniać',
    asideInstructions: 'Instrukcje',
    asideGeneralCopy: 'kopia ogólna',
    asideMemory: n('Reguły pracy: 1', 'Reguły pracy: {count}'),
    asideSkills: n('Umiejętności: 1', 'Umiejętności: {count}'),
    notIncluded:
      'Nie zawiera: pamięci autora, rozmów i plików, komputerów i logowań.',
    makeOwnEllipsis: 'Utwórz własny…',
    shareEllipsis: 'Udostępnij…', publishEllipsis: 'Opublikuj…', savedAsYouEdit: 'Prywatny szkic · zapisywany na bieżąco',
    whereItRuns: 'Gdzie działa',
    templateSection: 'Szablon', templateSectionDescription: named('Z niego inni tworzą własnego {name}.'), namedTemplate: named('Szablon {name}'), giveCopyEllipsis: 'Przekaż kopię…',
  },
  'zh-Hans': {
    draftKind: 'Bot模板 · 私有草稿',
    whatPeopleGet: '他人会得到',
    getsInstructions: '它的指令（通用副本）',
    getsMemory: n('来自记忆的规则 1 条', '来自记忆的规则 {count} 条'),
    getsSkills: n('技能 1 个', '技能 {count} 个'),
    getsNeeds: n('需要 1 个工具或登录', '需要 {count} 个工具或登录'),
    leftOutMemory: n('仅自己保留的记忆 1 条', '仅自己保留的记忆 {count} 条'),
    leftOutSkills: n('私有技能 1 个', '私有技能 {count} 个'),
    leftOutConversations: '对话和文件',
    leftOutMachines: '机器和登录',
    nothingShared: '在你审核前不会共享任何内容。',
    reviewShort: '审核',
    whatItDoes: '它能做什么',
    tryItWith: '试试',
    firstTaskHint: '归你之后，第一项任务一键即可开始。',
    whatItNeeds: '它需要什么',
    needsChecked:
      '创建你的副本时会在你的机器上检查。不包含任何密钥或登录；你连接自己的。',
    kindSoftware: '软件',
    kindAccount: '账户',
    kindMcp: 'MCP 服务器',
    whatYouGet: '你会得到',
    yourOwnBot: '你自己的 Bot · 可随意修改',
    asideInstructions: '指令',
    asideGeneralCopy: '通用副本',
    asideMemory: n('工作方式规则 1 条', '工作方式规则 {count} 条'),
    asideSkills: n('技能 1 个', '技能 {count} 个'),
    notIncluded: '不包括：作者的记忆、对话和文件、机器和登录。',
    makeOwnEllipsis: '创建我的…',
    shareEllipsis: '分享…', publishEllipsis: '发布…', savedAsYouEdit: '私有草稿 · 编辑时自动保存',
    whereItRuns: '运行位置',
    templateSection: '模板', templateSectionDescription: named('他人以此创建自己的{name}。'), namedTemplate: named('{name}模板'), giveCopyEllipsis: '提供副本…',
  },
  'zh-Hant': {
    draftKind: 'Bot範本 · 私人草稿',
    whatPeopleGet: '他人會得到',
    getsInstructions: '它的指令（通用副本）',
    getsMemory: n('來自記憶的規則 1 條', '來自記憶的規則 {count} 條'),
    getsSkills: n('技能 1 個', '技能 {count} 個'),
    getsNeeds: n('需要 1 個工具或登入', '需要 {count} 個工具或登入'),
    leftOutMemory: n('僅自己保留的記憶 1 條', '僅自己保留的記憶 {count} 條'),
    leftOutSkills: n('私人技能 1 個', '私人技能 {count} 個'),
    leftOutConversations: '對話和檔案',
    leftOutMachines: '機器和登入',
    nothingShared: '在你審核前不會分享任何內容。',
    reviewShort: '審核',
    whatItDoes: '它能做什麼',
    tryItWith: '試試',
    firstTaskHint: '歸你之後，第一項任務一鍵即可開始。',
    whatItNeeds: '它需要什麼',
    needsChecked:
      '建立你的副本時會在你的機器上檢查。不包含任何金鑰或登入；你連接自己的。',
    kindSoftware: '軟體',
    kindAccount: '帳戶',
    kindMcp: 'MCP 伺服器',
    whatYouGet: '你會得到',
    yourOwnBot: '你自己的 Bot · 可隨意修改',
    asideInstructions: '指令',
    asideGeneralCopy: '通用副本',
    asideMemory: n('工作方式規則 1 條', '工作方式規則 {count} 條'),
    asideSkills: n('技能 1 個', '技能 {count} 個'),
    notIncluded: '不包括：作者的記憶、對話和檔案、機器和登入。',
    makeOwnEllipsis: '建立我的…',
    shareEllipsis: '分享…', publishEllipsis: '發佈…', savedAsYouEdit: '私人草稿 · 編輯時自動儲存',
    whereItRuns: '執行位置',
    templateSection: '範本', templateSectionDescription: named('他人以此建立自己的{name}。'), namedTemplate: named('{name}範本'), giveCopyEllipsis: '提供副本…',
  },
} satisfies Record<SupportedLanguage, Words>;
