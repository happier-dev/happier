/**
 * Copy of an Environment's Telemetry tab and its one setup sheet (P7 J1, lab `p7Setup`). Wired as the
 * `deploymentTelemetry` namespace by every locale.
 */
type Name = Readonly<{ name: string }>;
type MachineName = Readonly<{ machine: string }>;

type Copy = Readonly<{
  tab: string;
  empty: Readonly<{
    title: (p: Name) => string;
    body: string;
    action: string;
    note: string;
  }>;
  recording: Readonly<{
    title: string;
    keptOn: (p: MachineName) => string;
    nextDeploy: string;
  }>;
  state: Readonly<{ on: string; off: string }>;
  sheet: Readonly<{
    title: (p: Name) => string;
    purpose: string;
    collector: string;
    collectorDescription: string;
    machine: string;
    noCollector: string;
    team: string;
    record: string;
    requests: string;
    requestsDescription: string;
    exceptions: string;
    exceptionsDescription: string;
    llm: string;
    llmDescription: string;
    metrics: string;
    metricsDescription: string;
    keptEncrypted: (p: MachineName) => string;
    keptPlain: (p: MachineName) => string;
    save: string;
    confirmDeleteTitle: string;
    confirmDelete: (p: MachineName) => string;
    deleteAndSave: string;
    noAccess: string;
    refused: Readonly<{
      collector_required: string;
      telemetry_role_inactive: string;
      machine_unavailable: string;
      other: string;
    }>;
  }>;
}>;

const en: Copy = {
  tab: 'Telemetry',
  empty: {
    title: ({ name }) => `See what ${name} does`,
    body: 'Slow endpoints, the queries each request runs, errors and model calls, kept on a Machine you choose. Agents can read them to fix what they find.',
    action: 'Set up telemetry…',
    note: 'Your app sends OpenTelemetry; Happier sets the variables at the next deploy.',
  },
  recording: {
    title: 'Recording',
    keptOn: ({ machine }) => `Kept on ${machine}.`,
    nextDeploy: 'Changes apply at the next deploy.',
  },
  state: { on: 'On', off: 'Off' },
  sheet: {
    title: ({ name }) => `Telemetry for ${name}`,
    purpose: 'What Happier records from this app, and where it keeps it.',
    collector: 'Collector',
    collectorDescription:
      'The Machine that receives and keeps what this Environment records.',
    machine: 'Machine',
    noCollector:
      'No Machine has its Telemetry role on yet. Turn it on for a Machine that stays on, in that Machine’s Roles.',
    team: 'Your teammates read telemetry from the same Machine, as this Environment’s permissions allow. Personal computers sleep, so choose one that stays on.',
    record: 'Record',
    requests: 'Requests and queries',
    requestsDescription:
      'Endpoints, traces, logs and the queries each request runs.',
    exceptions: 'Exceptions',
    exceptionsDescription:
      'Server errors become issues in PRs & Issues. Browser errors need a small addition to your app.',
    llm: 'App LLM calls',
    llmDescription:
      'Model, tokens and time for each call your app makes. Prompts and replies are never kept.',
    metrics: 'Runtime metrics',
    metricsDescription:
      'Heap, garbage collection, request duration and requests in flight.',
    keptEncrypted: ({ machine }) =>
      `Requests, stacks and logs stay on ${machine}. Issue titles and counts are saved to your account, encrypted.`,
    keptPlain: ({ machine }) =>
      `Requests, stacks and logs stay on ${machine}. Issue titles and counts are saved to your account.`,
    save: 'Save',
    confirmDeleteTitle: 'This deletes the telemetry kept so far',
    confirmDelete: ({ machine }) =>
      `${machine} deletes what it kept for this Environment. Save again to go ahead.`,
    deleteAndSave: 'Delete and save',
    noAccess:
      'Only people who can change this Environment’s variables can change its telemetry.',
    refused: {
      collector_required:
        'Choose a Machine to keep this Environment’s telemetry.',
      telemetry_role_inactive:
        'That Machine’s Telemetry role is off. Turn it on, or choose another Machine.',
      machine_unavailable:
        'That Machine isn’t in this Home anymore. Choose another one.',
      other: 'Telemetry couldn’t be saved. Your choices are kept here.',
    },
  },
};

const ca: Copy = {
  tab: 'Telemetria',
  empty: {
    title: ({ name }) => `Mira què fa ${name}`,
    body: 'Endpoints lents, les consultes de cada petició, errors i crides a models, guardats en una Màquina que tries. Els agents els poden llegir per arreglar el que trobin.',
    action: 'Configura la telemetria…',
    note: 'La teva app envia OpenTelemetry; Happier defineix les variables al proper desplegament.',
  },
  recording: {
    title: 'Registre',
    keptOn: ({ machine }) => `Es guarda a ${machine}.`,
    nextDeploy: 'Els canvis s’apliquen al proper desplegament.',
  },
  state: { on: 'Activat', off: 'Desactivat' },
  sheet: {
    title: ({ name }) => `Telemetria de ${name}`,
    purpose: 'Què registra Happier d’aquesta app i on ho guarda.',
    collector: 'Col·lector',
    collectorDescription:
      'La Màquina que rep i guarda el que registra aquest Entorn.',
    machine: 'Màquina',
    noCollector:
      'Encara cap Màquina té el rol de Telemetria activat. Activa’l en una Màquina que estigui sempre encesa, als seus Rols.',
    team: 'Els teus companys llegeixen la telemetria de la mateixa Màquina, segons els permisos d’aquest Entorn. Els ordinadors personals s’adormen; tria’n una que estigui sempre encesa.',
    record: 'Registra',
    requests: 'Peticions i consultes',
    requestsDescription:
      'Endpoints, traces, registres i les consultes de cada petició.',
    exceptions: 'Excepcions',
    exceptionsDescription:
      'Els errors del servidor es converteixen en incidències a PRs i incidències. Els errors del navegador necessiten un petit afegit a la teva app.',
    llm: 'Crides LLM de l’app',
    llmDescription:
      'Model, tokens i temps de cada crida que fa la teva app. Mai es guarden les instruccions ni les respostes.',
    metrics: 'Mètriques d’execució',
    metricsDescription:
      'Memòria, recollida d’escombraries, durada de les peticions i peticions en curs.',
    keptEncrypted: ({ machine }) =>
      `Les peticions, les piles i els registres es queden a ${machine}. Els títols i recomptes de les incidències es desen al teu compte, xifrats.`,
    keptPlain: ({ machine }) =>
      `Les peticions, les piles i els registres es queden a ${machine}. Els títols i recomptes de les incidències es desen al teu compte.`,
    save: 'Desa',
    confirmDeleteTitle: 'Això esborra la telemetria guardada fins ara',
    confirmDelete: ({ machine }) =>
      `${machine} esborra el que va guardar per a aquest Entorn. Torna a desar per continuar.`,
    deleteAndSave: 'Esborra i desa',
    noAccess:
      'Només qui pot canviar les variables d’aquest Entorn en pot canviar la telemetria.',
    refused: {
      collector_required:
        'Tria una Màquina per guardar la telemetria d’aquest Entorn.',
      telemetry_role_inactive:
        'El rol de Telemetria d’aquesta Màquina està desactivat. Activa’l o tria una altra Màquina.',
      machine_unavailable:
        'Aquesta Màquina ja no és en aquesta Home. Tria’n una altra.',
      other:
        'No s’ha pogut desar la telemetria. Les teves opcions es mantenen aquí.',
    },
  },
};

const de: Copy = {
  tab: 'Telemetrie',
  empty: {
    title: ({ name }) => `Sieh, was ${name} tut`,
    body: 'Langsame Endpunkte, die Abfragen jeder Anfrage, Fehler und Modellaufrufe, gespeichert auf einer Maschine deiner Wahl. Agenten können sie lesen, um zu beheben, was sie finden.',
    action: 'Telemetrie einrichten…',
    note: 'Deine App sendet OpenTelemetry; Happier setzt die Variablen beim nächsten Deployment.',
  },
  recording: {
    title: 'Aufzeichnung',
    keptOn: ({ machine }) => `Gespeichert auf ${machine}.`,
    nextDeploy: 'Änderungen gelten ab dem nächsten Deployment.',
  },
  state: { on: 'An', off: 'Aus' },
  sheet: {
    title: ({ name }) => `Telemetrie für ${name}`,
    purpose:
      'Was Happier von dieser App aufzeichnet und wo es gespeichert wird.',
    collector: 'Collector',
    collectorDescription:
      'Die Maschine, die empfängt und speichert, was diese Umgebung aufzeichnet.',
    machine: 'Maschine',
    noCollector:
      'Noch keine Maschine hat die Telemetrie-Rolle aktiviert. Aktiviere sie für eine Maschine, die immer läuft, in deren Rollen.',
    team: 'Deine Teammitglieder lesen die Telemetrie von derselben Maschine, soweit die Berechtigungen dieser Umgebung es erlauben. Persönliche Computer schlafen, wähle also eine, die immer läuft.',
    record: 'Aufzeichnen',
    requests: 'Anfragen und Abfragen',
    requestsDescription:
      'Endpunkte, Traces, Logs und die Abfragen jeder Anfrage.',
    exceptions: 'Ausnahmen',
    exceptionsDescription:
      'Serverfehler werden zu Issues in PRs & Issues. Browserfehler brauchen eine kleine Ergänzung in deiner App.',
    llm: 'LLM-Aufrufe der App',
    llmDescription:
      'Modell, Tokens und Dauer jedes Aufrufs deiner App. Prompts und Antworten werden nie gespeichert.',
    metrics: 'Laufzeitmetriken',
    metricsDescription:
      'Heap, Garbage Collection, Anfragedauer und laufende Anfragen.',
    keptEncrypted: ({ machine }) =>
      `Anfragen, Stacks und Logs bleiben auf ${machine}. Titel und Zahlen der Issues werden verschlüsselt in deinem Konto gespeichert.`,
    keptPlain: ({ machine }) =>
      `Anfragen, Stacks und Logs bleiben auf ${machine}. Titel und Zahlen der Issues werden in deinem Konto gespeichert.`,
    save: 'Speichern',
    confirmDeleteTitle:
      'Damit wird die bisher gespeicherte Telemetrie gelöscht',
    confirmDelete: ({ machine }) =>
      `${machine} löscht, was es für diese Umgebung gespeichert hat. Speichere erneut, um fortzufahren.`,
    deleteAndSave: 'Löschen und speichern',
    noAccess:
      'Nur wer die Variablen dieser Umgebung ändern darf, kann ihre Telemetrie ändern.',
    refused: {
      collector_required:
        'Wähle eine Maschine, die die Telemetrie dieser Umgebung speichert.',
      telemetry_role_inactive:
        'Die Telemetrie-Rolle dieser Maschine ist aus. Aktiviere sie oder wähle eine andere Maschine.',
      machine_unavailable:
        'Diese Maschine ist nicht mehr in diesem Home. Wähle eine andere.',
      other:
        'Die Telemetrie konnte nicht gespeichert werden. Deine Auswahl bleibt hier erhalten.',
    },
  },
};

const es: Copy = {
  tab: 'Telemetría',
  empty: {
    title: ({ name }) => `Mira qué hace ${name}`,
    body: 'Endpoints lentos, las consultas de cada petición, errores y llamadas a modelos, guardados en una Máquina que eliges. Los agentes pueden leerlos para arreglar lo que encuentren.',
    action: 'Configurar telemetría…',
    note: 'Tu app envía OpenTelemetry; Happier define las variables en el próximo despliegue.',
  },
  recording: {
    title: 'Registro',
    keptOn: ({ machine }) => `Se guarda en ${machine}.`,
    nextDeploy: 'Los cambios se aplican en el próximo despliegue.',
  },
  state: { on: 'Activado', off: 'Desactivado' },
  sheet: {
    title: ({ name }) => `Telemetría de ${name}`,
    purpose: 'Qué registra Happier de esta app y dónde lo guarda.',
    collector: 'Colector',
    collectorDescription:
      'La Máquina que recibe y guarda lo que registra este Entorno.',
    machine: 'Máquina',
    noCollector:
      'Ninguna Máquina tiene aún el rol de Telemetría activado. Actívalo en una Máquina que esté siempre encendida, en sus Roles.',
    team: 'Tus compañeros leen la telemetría desde la misma Máquina, según los permisos de este Entorno. Los ordenadores personales se suspenden; elige una que esté siempre encendida.',
    record: 'Registrar',
    requests: 'Peticiones y consultas',
    requestsDescription:
      'Endpoints, trazas, registros y las consultas de cada petición.',
    exceptions: 'Excepciones',
    exceptionsDescription:
      'Los errores del servidor se convierten en incidencias en PRs e incidencias. Los errores del navegador necesitan un pequeño añadido en tu app.',
    llm: 'Llamadas LLM de la app',
    llmDescription:
      'Modelo, tokens y tiempo de cada llamada de tu app. Nunca se guardan las instrucciones ni las respuestas.',
    metrics: 'Métricas de ejecución',
    metricsDescription:
      'Memoria, recolección de basura, duración de las peticiones y peticiones en curso.',
    keptEncrypted: ({ machine }) =>
      `Las peticiones, las pilas y los registros se quedan en ${machine}. Los títulos y recuentos de las incidencias se guardan en tu cuenta, cifrados.`,
    keptPlain: ({ machine }) =>
      `Las peticiones, las pilas y los registros se quedan en ${machine}. Los títulos y recuentos de las incidencias se guardan en tu cuenta.`,
    save: 'Guardar',
    confirmDeleteTitle: 'Esto borra la telemetría guardada hasta ahora',
    confirmDelete: ({ machine }) =>
      `${machine} borra lo que guardó para este Entorno. Vuelve a guardar para continuar.`,
    deleteAndSave: 'Borrar y guardar',
    noAccess:
      'Solo quien puede cambiar las variables de este Entorno puede cambiar su telemetría.',
    refused: {
      collector_required:
        'Elige una Máquina para guardar la telemetría de este Entorno.',
      telemetry_role_inactive:
        'El rol de Telemetría de esa Máquina está desactivado. Actívalo o elige otra Máquina.',
      machine_unavailable: 'Esa Máquina ya no está en esta Home. Elige otra.',
      other:
        'No se pudo guardar la telemetría. Tus opciones se mantienen aquí.',
    },
  },
};

const fr: Copy = {
  tab: 'Télémétrie',
  empty: {
    title: ({ name }) => `Voyez ce que fait ${name}`,
    body: 'Endpoints lents, les requêtes de chaque appel, erreurs et appels de modèles, conservés sur une Machine de votre choix. Les agents peuvent les lire pour corriger ce qu’ils trouvent.',
    action: 'Configurer la télémétrie…',
    note: 'Votre app envoie OpenTelemetry ; Happier définit les variables au prochain déploiement.',
  },
  recording: {
    title: 'Enregistrement',
    keptOn: ({ machine }) => `Conservé sur ${machine}.`,
    nextDeploy: 'Les changements s’appliquent au prochain déploiement.',
  },
  state: { on: 'Activé', off: 'Désactivé' },
  sheet: {
    title: ({ name }) => `Télémétrie de ${name}`,
    purpose: 'Ce que Happier enregistre de cette app, et où il le conserve.',
    collector: 'Collecteur',
    collectorDescription:
      'La Machine qui reçoit et conserve ce que cet Environnement enregistre.',
    machine: 'Machine',
    noCollector:
      'Aucune Machine n’a encore son rôle Télémétrie activé. Activez-le pour une Machine toujours allumée, dans ses Rôles.',
    team: 'Vos coéquipiers lisent la télémétrie depuis la même Machine, selon les permissions de cet Environnement. Les ordinateurs personnels se mettent en veille : choisissez-en une toujours allumée.',
    record: 'Enregistrer',
    requests: 'Requêtes et appels',
    requestsDescription:
      'Endpoints, traces, journaux et les requêtes de chaque appel.',
    exceptions: 'Exceptions',
    exceptionsDescription:
      'Les erreurs serveur deviennent des tickets dans PRs et tickets. Les erreurs du navigateur demandent un petit ajout à votre app.',
    llm: 'Appels LLM de l’app',
    llmDescription:
      'Modèle, tokens et durée de chaque appel de votre app. Les prompts et les réponses ne sont jamais conservés.',
    metrics: 'Métriques d’exécution',
    metricsDescription:
      'Tas, ramasse-miettes, durée des requêtes et requêtes en cours.',
    keptEncrypted: ({ machine }) =>
      `Les requêtes, piles et journaux restent sur ${machine}. Les titres et compteurs des tickets sont enregistrés dans votre compte, chiffrés.`,
    keptPlain: ({ machine }) =>
      `Les requêtes, piles et journaux restent sur ${machine}. Les titres et compteurs des tickets sont enregistrés dans votre compte.`,
    save: 'Enregistrer',
    confirmDeleteTitle: 'Cela supprime la télémétrie conservée jusqu’ici',
    confirmDelete: ({ machine }) =>
      `${machine} supprime ce qu’il a conservé pour cet Environnement. Enregistrez à nouveau pour continuer.`,
    deleteAndSave: 'Supprimer et enregistrer',
    noAccess:
      'Seules les personnes qui peuvent modifier les variables de cet Environnement peuvent modifier sa télémétrie.',
    refused: {
      collector_required:
        'Choisissez une Machine pour conserver la télémétrie de cet Environnement.',
      telemetry_role_inactive:
        'Le rôle Télémétrie de cette Machine est désactivé. Activez-le ou choisissez une autre Machine.',
      machine_unavailable:
        'Cette Machine n’est plus dans ce Home. Choisissez-en une autre.',
      other:
        'La télémétrie n’a pas pu être enregistrée. Vos choix sont conservés ici.',
    },
  },
};

const it: Copy = {
  tab: 'Telemetria',
  empty: {
    title: ({ name }) => `Guarda cosa fa ${name}`,
    body: 'Endpoint lenti, le query di ogni richiesta, errori e chiamate ai modelli, conservati su una Macchina che scegli. Gli agenti possono leggerli per correggere ciò che trovano.',
    action: 'Configura la telemetria…',
    note: 'La tua app invia OpenTelemetry; Happier imposta le variabili al prossimo deploy.',
  },
  recording: {
    title: 'Registrazione',
    keptOn: ({ machine }) => `Conservata su ${machine}.`,
    nextDeploy: 'Le modifiche si applicano al prossimo deploy.',
  },
  state: { on: 'Attivo', off: 'Disattivo' },
  sheet: {
    title: ({ name }) => `Telemetria di ${name}`,
    purpose: 'Cosa registra Happier di questa app e dove lo conserva.',
    collector: 'Collettore',
    collectorDescription:
      'La Macchina che riceve e conserva ciò che registra questo Ambiente.',
    machine: 'Macchina',
    noCollector:
      'Nessuna Macchina ha ancora il ruolo Telemetria attivo. Attivalo su una Macchina sempre accesa, nei suoi Ruoli.',
    team: 'I tuoi colleghi leggono la telemetria dalla stessa Macchina, secondo i permessi di questo Ambiente. I computer personali vanno in sospensione: scegline una sempre accesa.',
    record: 'Registra',
    requests: 'Richieste e query',
    requestsDescription: 'Endpoint, trace, log e le query di ogni richiesta.',
    exceptions: 'Eccezioni',
    exceptionsDescription:
      'Gli errori del server diventano issue in PR e issue. Gli errori del browser richiedono una piccola aggiunta alla tua app.',
    llm: 'Chiamate LLM dell’app',
    llmDescription:
      'Modello, token e durata di ogni chiamata della tua app. Prompt e risposte non vengono mai conservati.',
    metrics: 'Metriche di runtime',
    metricsDescription:
      'Heap, garbage collection, durata delle richieste e richieste in corso.',
    keptEncrypted: ({ machine }) =>
      `Richieste, stack e log restano su ${machine}. Titoli e conteggi delle issue sono salvati nel tuo account, cifrati.`,
    keptPlain: ({ machine }) =>
      `Richieste, stack e log restano su ${machine}. Titoli e conteggi delle issue sono salvati nel tuo account.`,
    save: 'Salva',
    confirmDeleteTitle: 'Questo elimina la telemetria conservata finora',
    confirmDelete: ({ machine }) =>
      `${machine} elimina ciò che ha conservato per questo Ambiente. Salva di nuovo per procedere.`,
    deleteAndSave: 'Elimina e salva',
    noAccess:
      'Solo chi può modificare le variabili di questo Ambiente può modificarne la telemetria.',
    refused: {
      collector_required:
        'Scegli una Macchina in cui conservare la telemetria di questo Ambiente.',
      telemetry_role_inactive:
        'Il ruolo Telemetria di quella Macchina è disattivo. Attivalo o scegli un’altra Macchina.',
      machine_unavailable:
        'Quella Macchina non è più in questa Home. Scegline un’altra.',
      other: 'Impossibile salvare la telemetria. Le tue scelte restano qui.',
    },
  },
};

const ja: Copy = {
  tab: 'テレメトリ',
  empty: {
    title: ({ name }) => `${name} の動きを見る`,
    body: '遅いエンドポイント、各リクエストのクエリ、エラー、モデル呼び出しを、選んだマシンに保存します。エージェントはそれを読んで見つけた問題を直せます。',
    action: 'テレメトリを設定…',
    note: 'アプリが OpenTelemetry を送信し、Happier が次回のデプロイで変数を設定します。',
  },
  recording: {
    title: '記録',
    keptOn: ({ machine }) => `${machine} に保存されます。`,
    nextDeploy: '変更は次回のデプロイで反映されます。',
  },
  state: { on: 'オン', off: 'オフ' },
  sheet: {
    title: ({ name }) => `${name} のテレメトリ`,
    purpose: 'Happier がこのアプリから何を記録し、どこに保存するか。',
    collector: 'コレクター',
    collectorDescription: 'この環境が記録するものを受け取り、保存するマシン。',
    machine: 'マシン',
    noCollector:
      'テレメトリの役割がオンのマシンはまだありません。常に起動しているマシンの「役割」でオンにしてください。',
    team: 'チームメンバーは、この環境の権限の範囲で同じマシンからテレメトリを読みます。個人のコンピューターはスリープするので、常に起動しているマシンを選んでください。',
    record: '記録する内容',
    requests: 'リクエストとクエリ',
    requestsDescription:
      'エンドポイント、トレース、ログ、各リクエストのクエリ。',
    exceptions: '例外',
    exceptionsDescription:
      'サーバーのエラーは PR と Issue の Issue になります。ブラウザーのエラーにはアプリへの小さな追加が必要です。',
    llm: 'アプリの LLM 呼び出し',
    llmDescription:
      'アプリの各呼び出しのモデル、トークン、時間。プロンプトと応答は保存しません。',
    metrics: 'ランタイムメトリクス',
    metricsDescription:
      'ヒープ、ガベージコレクション、リクエスト時間、処理中のリクエスト。',
    keptEncrypted: ({ machine }) =>
      `リクエスト、スタック、ログは ${machine} に残ります。Issue のタイトルと件数は暗号化してアカウントに保存されます。`,
    keptPlain: ({ machine }) =>
      `リクエスト、スタック、ログは ${machine} に残ります。Issue のタイトルと件数はアカウントに保存されます。`,
    save: '保存',
    confirmDeleteTitle: 'これまでに保存したテレメトリが削除されます',
    confirmDelete: ({ machine }) =>
      `${machine} はこの環境のために保存した内容を削除します。続けるにはもう一度保存してください。`,
    deleteAndSave: '削除して保存',
    noAccess: 'この環境の変数を変更できる人だけがテレメトリを変更できます。',
    refused: {
      collector_required:
        'この環境のテレメトリを保存するマシンを選んでください。',
      telemetry_role_inactive:
        'そのマシンのテレメトリの役割はオフです。オンにするか、別のマシンを選んでください。',
      machine_unavailable:
        'そのマシンはもうこの Home にありません。別のマシンを選んでください。',
      other: 'テレメトリを保存できませんでした。選択内容はここに残っています。',
    },
  },
};

const pl: Copy = {
  tab: 'Telemetria',
  empty: {
    title: ({ name }) => `Zobacz, co robi ${name}`,
    body: 'Wolne endpointy, zapytania każdego żądania, błędy i wywołania modeli, przechowywane na wybranej Maszynie. Agenci mogą je czytać, aby naprawić to, co znajdą.',
    action: 'Skonfiguruj telemetrię…',
    note: 'Twoja aplikacja wysyła OpenTelemetry; Happier ustawia zmienne przy następnym wdrożeniu.',
  },
  recording: {
    title: 'Zapisywanie',
    keptOn: ({ machine }) => `Przechowywane na ${machine}.`,
    nextDeploy: 'Zmiany zaczną działać przy następnym wdrożeniu.',
  },
  state: { on: 'Włączone', off: 'Wyłączone' },
  sheet: {
    title: ({ name }) => `Telemetria: ${name}`,
    purpose: 'Co Happier zapisuje z tej aplikacji i gdzie to przechowuje.',
    collector: 'Kolektor',
    collectorDescription:
      'Maszyna, która odbiera i przechowuje to, co zapisuje to Środowisko.',
    machine: 'Maszyna',
    noCollector:
      'Żadna Maszyna nie ma jeszcze włączonej roli Telemetria. Włącz ją dla Maszyny, która jest zawsze włączona, w jej Rolach.',
    team: 'Członkowie zespołu czytają telemetrię z tej samej Maszyny, na ile pozwalają uprawnienia tego Środowiska. Komputery osobiste usypiają, więc wybierz taką, która jest zawsze włączona.',
    record: 'Zapisuj',
    requests: 'Żądania i zapytania',
    requestsDescription: 'Endpointy, ślady, logi i zapytania każdego żądania.',
    exceptions: 'Wyjątki',
    exceptionsDescription:
      'Błędy serwera stają się zgłoszeniami w PR-ach i zgłoszeniach. Błędy przeglądarki wymagają małego dodatku w aplikacji.',
    llm: 'Wywołania LLM aplikacji',
    llmDescription:
      'Model, tokeny i czas każdego wywołania aplikacji. Prompty i odpowiedzi nigdy nie są przechowywane.',
    metrics: 'Metryki działania',
    metricsDescription: 'Sterta, odśmiecanie, czas żądań i żądania w toku.',
    keptEncrypted: ({ machine }) =>
      `Żądania, stosy i logi zostają na ${machine}. Tytuły i liczby zgłoszeń są zapisywane na Twoim koncie, zaszyfrowane.`,
    keptPlain: ({ machine }) =>
      `Żądania, stosy i logi zostają na ${machine}. Tytuły i liczby zgłoszeń są zapisywane na Twoim koncie.`,
    save: 'Zapisz',
    confirmDeleteTitle: 'To usunie dotychczas zapisaną telemetrię',
    confirmDelete: ({ machine }) =>
      `${machine} usunie to, co przechowywał dla tego Środowiska. Zapisz ponownie, aby kontynuować.`,
    deleteAndSave: 'Usuń i zapisz',
    noAccess:
      'Tylko osoby, które mogą zmieniać zmienne tego Środowiska, mogą zmieniać jego telemetrię.',
    refused: {
      collector_required:
        'Wybierz Maszynę, która będzie przechowywać telemetrię tego Środowiska.',
      telemetry_role_inactive:
        'Rola Telemetria tej Maszyny jest wyłączona. Włącz ją lub wybierz inną Maszynę.',
      machine_unavailable: 'Tej Maszyny nie ma już w tym Home. Wybierz inną.',
      other:
        'Nie udało się zapisać telemetrii. Twoje wybory zostały zachowane.',
    },
  },
};

const pt: Copy = {
  tab: 'Telemetria',
  empty: {
    title: ({ name }) => `Veja o que ${name} faz`,
    body: 'Endpoints lentos, as consultas de cada requisição, erros e chamadas a modelos, guardados numa Máquina que você escolhe. Os agentes podem lê-los para corrigir o que encontrarem.',
    action: 'Configurar telemetria…',
    note: 'Seu app envia OpenTelemetry; o Happier define as variáveis no próximo deploy.',
  },
  recording: {
    title: 'Registro',
    keptOn: ({ machine }) => `Guardado em ${machine}.`,
    nextDeploy: 'As mudanças valem a partir do próximo deploy.',
  },
  state: { on: 'Ativado', off: 'Desativado' },
  sheet: {
    title: ({ name }) => `Telemetria de ${name}`,
    purpose: 'O que o Happier registra deste app e onde guarda.',
    collector: 'Coletor',
    collectorDescription:
      'A Máquina que recebe e guarda o que este Ambiente registra.',
    machine: 'Máquina',
    noCollector:
      'Nenhuma Máquina tem ainda o papel Telemetria ativado. Ative-o numa Máquina sempre ligada, nos Papéis dela.',
    team: 'Seus colegas leem a telemetria da mesma Máquina, conforme as permissões deste Ambiente. Computadores pessoais dormem; escolha uma sempre ligada.',
    record: 'Registrar',
    requests: 'Requisições e consultas',
    requestsDescription:
      'Endpoints, traces, logs e as consultas de cada requisição.',
    exceptions: 'Exceções',
    exceptionsDescription:
      'Erros do servidor viram issues em PRs e issues. Erros do navegador precisam de um pequeno acréscimo no seu app.',
    llm: 'Chamadas LLM do app',
    llmDescription:
      'Modelo, tokens e tempo de cada chamada do seu app. Prompts e respostas nunca são guardados.',
    metrics: 'Métricas de execução',
    metricsDescription:
      'Heap, coleta de lixo, duração das requisições e requisições em andamento.',
    keptEncrypted: ({ machine }) =>
      `Requisições, pilhas e logs ficam em ${machine}. Títulos e contagens das issues são salvos na sua conta, criptografados.`,
    keptPlain: ({ machine }) =>
      `Requisições, pilhas e logs ficam em ${machine}. Títulos e contagens das issues são salvos na sua conta.`,
    save: 'Salvar',
    confirmDeleteTitle: 'Isso apaga a telemetria guardada até agora',
    confirmDelete: ({ machine }) =>
      `${machine} apaga o que guardou para este Ambiente. Salve de novo para continuar.`,
    deleteAndSave: 'Apagar e salvar',
    noAccess:
      'Só quem pode alterar as variáveis deste Ambiente pode alterar a telemetria dele.',
    refused: {
      collector_required:
        'Escolha uma Máquina para guardar a telemetria deste Ambiente.',
      telemetry_role_inactive:
        'O papel Telemetria dessa Máquina está desativado. Ative-o ou escolha outra Máquina.',
      machine_unavailable:
        'Essa Máquina não está mais neste Home. Escolha outra.',
      other:
        'Não foi possível salvar a telemetria. Suas escolhas continuam aqui.',
    },
  },
};

const ru: Copy = {
  tab: 'Телеметрия',
  empty: {
    title: ({ name }) => `Посмотрите, что делает ${name}`,
    body: 'Медленные эндпоинты, запросы к базе каждого запроса, ошибки и вызовы моделей хранятся на выбранной вами Машине. Агенты могут читать их, чтобы исправлять найденное.',
    action: 'Настроить телеметрию…',
    note: 'Ваше приложение отправляет OpenTelemetry; Happier задаёт переменные при следующем развёртывании.',
  },
  recording: {
    title: 'Запись',
    keptOn: ({ machine }) => `Хранится на ${machine}.`,
    nextDeploy: 'Изменения вступят в силу при следующем развёртывании.',
  },
  state: { on: 'Вкл.', off: 'Выкл.' },
  sheet: {
    title: ({ name }) => `Телеметрия: ${name}`,
    purpose: 'Что Happier записывает из этого приложения и где хранит.',
    collector: 'Сборщик',
    collectorDescription:
      'Машина, которая получает и хранит то, что записывает это Окружение.',
    machine: 'Машина',
    noCollector:
      'Ни у одной Машины ещё не включена роль «Телеметрия». Включите её для всегда работающей Машины в её Ролях.',
    team: 'Ваши коллеги читают телеметрию с той же Машины в пределах прав этого Окружения. Личные компьютеры засыпают, поэтому выберите всегда работающую.',
    record: 'Записывать',
    requests: 'Запросы и обращения к базе',
    requestsDescription:
      'Эндпоинты, трассировки, журналы и обращения к базе каждого запроса.',
    exceptions: 'Исключения',
    exceptionsDescription:
      'Ошибки сервера становятся задачами в «PR и задачах». Ошибкам браузера нужно небольшое дополнение в приложении.',
    llm: 'Вызовы LLM приложения',
    llmDescription:
      'Модель, токены и время каждого вызова вашего приложения. Промпты и ответы никогда не сохраняются.',
    metrics: 'Метрики выполнения',
    metricsDescription:
      'Куча, сборка мусора, длительность запросов и запросы в работе.',
    keptEncrypted: ({ machine }) =>
      `Запросы, стеки и журналы остаются на ${machine}. Названия и счётчики задач сохраняются в вашем аккаунте в зашифрованном виде.`,
    keptPlain: ({ machine }) =>
      `Запросы, стеки и журналы остаются на ${machine}. Названия и счётчики задач сохраняются в вашем аккаунте.`,
    save: 'Сохранить',
    confirmDeleteTitle: 'Это удалит сохранённую до сих пор телеметрию',
    confirmDelete: ({ machine }) =>
      `${machine} удалит то, что хранила для этого Окружения. Сохраните ещё раз, чтобы продолжить.`,
    deleteAndSave: 'Удалить и сохранить',
    noAccess:
      'Изменять телеметрию могут только те, кто может менять переменные этого Окружения.',
    refused: {
      collector_required:
        'Выберите Машину для хранения телеметрии этого Окружения.',
      telemetry_role_inactive:
        'Роль «Телеметрия» у этой Машины выключена. Включите её или выберите другую Машину.',
      machine_unavailable:
        'Этой Машины больше нет в этом Home. Выберите другую.',
      other: 'Не удалось сохранить телеметрию. Ваш выбор сохранён здесь.',
    },
  },
};

const zhHans: Copy = {
  tab: '遥测',
  empty: {
    title: ({ name }) => `看看 ${name} 在做什么`,
    body: '缓慢的端点、每个请求运行的查询、错误和模型调用，保存在你选择的机器上。代理可以读取它们来修复发现的问题。',
    action: '设置遥测…',
    note: '你的应用发送 OpenTelemetry；Happier 会在下次部署时设置变量。',
  },
  recording: {
    title: '记录',
    keptOn: ({ machine }) => `保存在 ${machine}。`,
    nextDeploy: '更改将在下次部署时生效。',
  },
  state: { on: '开', off: '关' },
  sheet: {
    title: ({ name }) => `${name} 的遥测`,
    purpose: 'Happier 从这个应用记录什么，以及保存在哪里。',
    collector: '收集器',
    collectorDescription: '接收并保存此环境所记录内容的机器。',
    machine: '机器',
    noCollector:
      '还没有机器开启遥测角色。请在一台始终在线的机器的“角色”中开启它。',
    team: '队友会在此环境权限允许的范围内，从同一台机器读取遥测。个人电脑会休眠，请选择一台始终在线的机器。',
    record: '记录内容',
    requests: '请求和查询',
    requestsDescription: '端点、链路追踪、日志以及每个请求运行的查询。',
    exceptions: '异常',
    exceptionsDescription:
      '服务器错误会成为“PR 和问题”中的问题。浏览器错误需要在应用中添加一小段代码。',
    llm: '应用的 LLM 调用',
    llmDescription: '应用每次调用的模型、令牌和耗时。从不保存提示词和回复。',
    metrics: '运行时指标',
    metricsDescription: '堆内存、垃圾回收、请求耗时和进行中的请求。',
    keptEncrypted: ({ machine }) =>
      `请求、堆栈和日志保留在 ${machine}。问题的标题和计数会加密保存到你的账户。`,
    keptPlain: ({ machine }) =>
      `请求、堆栈和日志保留在 ${machine}。问题的标题和计数会保存到你的账户。`,
    save: '保存',
    confirmDeleteTitle: '这会删除目前保存的遥测',
    confirmDelete: ({ machine }) =>
      `${machine} 会删除它为此环境保存的内容。再次保存以继续。`,
    deleteAndSave: '删除并保存',
    noAccess: '只有可以更改此环境变量的人才能更改它的遥测。',
    refused: {
      collector_required: '请选择一台机器来保存此环境的遥测。',
      telemetry_role_inactive:
        '那台机器的遥测角色已关闭。请开启它，或选择另一台机器。',
      machine_unavailable: '那台机器已不在此 Home 中。请选择另一台。',
      other: '无法保存遥测。你的选择保留在这里。',
    },
  },
};

const zhHant: Copy = {
  tab: '遙測',
  empty: {
    title: ({ name }) => `看看 ${name} 在做什麼`,
    body: '緩慢的端點、每個請求執行的查詢、錯誤和模型呼叫，保存在你選擇的機器上。代理可以讀取它們來修正發現的問題。',
    action: '設定遙測…',
    note: '你的應用程式會傳送 OpenTelemetry；Happier 會在下次部署時設定變數。',
  },
  recording: {
    title: '記錄',
    keptOn: ({ machine }) => `保存在 ${machine}。`,
    nextDeploy: '變更會在下次部署時生效。',
  },
  state: { on: '開', off: '關' },
  sheet: {
    title: ({ name }) => `${name} 的遙測`,
    purpose: 'Happier 從這個應用程式記錄什麼，以及保存在哪裡。',
    collector: '收集器',
    collectorDescription: '接收並保存此環境所記錄內容的機器。',
    machine: '機器',
    noCollector:
      '還沒有機器開啟遙測角色。請在一台始終在線的機器的「角色」中開啟它。',
    team: '隊友會在此環境權限允許的範圍內，從同一台機器讀取遙測。個人電腦會休眠，請選擇一台始終在線的機器。',
    record: '記錄內容',
    requests: '請求和查詢',
    requestsDescription: '端點、追蹤、日誌以及每個請求執行的查詢。',
    exceptions: '例外',
    exceptionsDescription:
      '伺服器錯誤會成為「PR 和問題」中的問題。瀏覽器錯誤需要在應用程式中加入一小段程式碼。',
    llm: '應用程式的 LLM 呼叫',
    llmDescription:
      '應用程式每次呼叫的模型、權杖和耗時。從不保存提示詞和回覆。',
    metrics: '執行階段指標',
    metricsDescription: '堆積記憶體、垃圾回收、請求耗時和進行中的請求。',
    keptEncrypted: ({ machine }) =>
      `請求、堆疊和日誌保留在 ${machine}。問題的標題和計數會加密儲存到你的帳號。`,
    keptPlain: ({ machine }) =>
      `請求、堆疊和日誌保留在 ${machine}。問題的標題和計數會儲存到你的帳號。`,
    save: '儲存',
    confirmDeleteTitle: '這會刪除目前保存的遙測',
    confirmDelete: ({ machine }) =>
      `${machine} 會刪除它為此環境保存的內容。再次儲存以繼續。`,
    deleteAndSave: '刪除並儲存',
    noAccess: '只有可以變更此環境變數的人才能變更它的遙測。',
    refused: {
      collector_required: '請選擇一台機器來保存此環境的遙測。',
      telemetry_role_inactive:
        '那台機器的遙測角色已關閉。請開啟它，或選擇另一台機器。',
      machine_unavailable: '那台機器已不在此 Home 中。請選擇另一台。',
      other: '無法儲存遙測。你的選擇保留在這裡。',
    },
  },
};

export const deploymentTelemetryTranslations = {
  en,
  ca,
  de,
  es,
  fr,
  it,
  ja,
  pl,
  pt,
  ru,
  'zh-Hans': zhHans,
  'zh-Hant': zhHant,
} as const;
