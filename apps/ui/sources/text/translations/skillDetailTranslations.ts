// Skill detail and new-skill draft copy (P6 U6.3, sd D/E/Dp, sx X1/X2). Mounted under `capabilities.skillDetail`.

type Count = Readonly<{ count: number }>;

export type SkillDetailTranslation = Readonly<{
  whereDescription: string;
  tokensWhenUsed: (params: Readonly<{ tokens: string }>) => string;
  menu: Readonly<{
    duplicate: string;
    makeCopy: string;
    moveToFolder: string;
    noFolder: string;
    exportZip: string;
    copyLink: string;
    linkCopied: string;
  }>;
  banner: Readonly<{
    couldntLoadTitle: string;
    couldntLoadBody: string;
  }>;
  instructions: Readonly<{
    title: string;
    edit: string;
    done: string;
    preview: string;
    showAll: string;
    showLess: string;
    saving: string;
    saved: string;
    saveFailed: string;
    conflict: string;
    reviewBoth: string;
    keepMine: string;
    takeTheirs: string;
    yours: string;
    theirs: string;
    lintOk: string;
    lintMissingName: string;
    lintMissingDescription: string;
    lintNoFrontmatter: string;
    readOnlyPlugin: string;
  }>;
  files: Readonly<{
    title: string;
    description: (params: Count) => string;
    descriptionScripts: (
      params: Readonly<{ count: number; scripts: number }>,
    ) => string;
    script: string;
    addFile: string;
    addFilePrompt: string;
    addFilePlaceholder: string;
    remove: string;
    removeTitle: (params: Readonly<{ path: string }>) => string;
    removeBody: string;
    more: (params: Count) => string;
    binary: string;
    loading: string;
    afterAdd: string;
  }>;
  source: Readonly<{
    title: string;
    descriptionReview: string;
    descriptionAuto: string;
    descriptionPinned: string;
    descriptionOwn: string;
    writtenByYou: string;
    writtenByYouBody: string;
    uploadedByYou: string;
    foundOn: (params: Readonly<{ machine: string }>) => string;
    foundOnBody: (params: Readonly<{ path: string }>) => string;
    firstParty: string;
    verifiedByDigest: string;
    noDigestPublished: string;
    added: (params: Readonly<{ date: string }>) => string;
    updates: string;
    upToDate: string;
    updateAvailable: string;
    removedFromSource: string;
    notChecked: string;
    checked: (params: Readonly<{ time: string }>) => string;
    checkNow: string;
    view: string;
    auto: string;
    autoBody: string;
    pin: string;
    pinBody: string;
    checkFailed: string;
  }>;
  machines: Readonly<{
    description: string;
    nowhere: string;
    offline: string;
    lastKnown: (params: Readonly<{ time: string }>) => string;
    masked: (params: Readonly<{ agent: string; machine: string }>) => string;
    cantLoad: (params: Readonly<{ agents: string }>) => string;
    previewFailed: (params: Readonly<{ agent: string }>) => string;
    checking: string;
    projectNote: string;
    noAgent: string;
    offlineCount: (params: Count) => string;
    summaryOn: (params: Readonly<{ agents: string; machine: string }>) => string;
    summaryOnMany: (params: Readonly<{ agents: string; count: number }>) => string;
  }>;
  details: Readonly<{
    title: string;
    summary: string;
    revision: string;
    contentHash: string;
    alsoInstall: (params: Readonly<{ machine: string }>) => string;
    alsoInstallBody: string;
    installed: string;
    install: string;
  }>;
  leave: Readonly<{
    remove: string;
    footnote: string;
    confirmTitle: (params: Readonly<{ name: string }>) => string;
    confirmBody: string;
    confirm: string;
  }>;
  draft: Readonly<{
    title: string;
    purpose: string;
    add: string;
    adding: string;
    addFailed: string;
  }>;
}>;

const en: SkillDetailTranslation = {
  whereDescription:
    'Set it once and every machine follows. The most specific rule wins.',
  tokensWhenUsed: ({ tokens }) => `${tokens} tokens when used`,
  menu: {
    duplicate: 'Duplicate',
    makeCopy: 'Make an editable copy',
    moveToFolder: 'Move to folder',
    noFolder: 'No folder',
    exportZip: 'Export as .zip',
    copyLink: 'Copy link',
    linkCopied: 'Link copied',
  },
  banner: {
    couldntLoadTitle: 'Couldn’t load this skill',
    couldntLoadBody:
      'Your library didn’t answer. Sessions keep the copy they already have.',
  },
  instructions: {
    title: 'Instructions',
    edit: 'Edit',
    done: 'Done',
    preview: 'Preview',
    showAll: 'Show all',
    showLess: 'Show less',
    saving: 'Saving…',
    saved: 'Saved · applies to new sessions',
    saveFailed: 'Couldn’t save. Your text is kept.',
    conflict: 'Changed on another device',
    reviewBoth: 'Review both',
    keepMine: 'Keep mine',
    takeTheirs: 'Take theirs',
    yours: 'Yours',
    theirs: 'Theirs',
    lintOk: 'Name and description are set',
    lintMissingName: 'Add a name to the frontmatter',
    lintMissingDescription: 'Add a description, so agents know when to use it',
    lintNoFrontmatter: 'Start with a frontmatter block: name and description',
    readOnlyPlugin: 'Ships with its plugin and follows its version.',
  },
  files: {
    title: 'Files',
    description: ({ count }) =>
      count === 1 ? '1 file, no scripts.' : `${count} files, no scripts.`,
    descriptionScripts: ({ count, scripts }) =>
      `${count} files, ${scripts === 1 ? '1 runs as a script' : `${scripts} run as scripts`}.`,
    script: 'Script',
    addFile: 'Add a file',
    addFilePrompt: 'Its path inside the skill.',
    addFilePlaceholder: 'reference/notes.md',
    remove: 'Remove',
    removeTitle: ({ path }) => `Remove ${path}?`,
    removeBody: 'New sessions get the skill without it.',
    more: ({ count }) => `${count} more`,
    binary: 'Not a text file',
    loading: 'Opening…',
    afterAdd: 'Add more files once the skill is in your library.',
  },
  source: {
    title: 'Source and updates',
    descriptionReview: 'Changes from the source wait for your review.',
    descriptionAuto:
      'Changes from the source arrive on their own, unless you changed it.',
    descriptionPinned:
      'Pinned to a version. Changes from the source wait until you unpin.',
    descriptionOwn: 'Yours to change. Nothing updates it but you.',
    writtenByYou: 'Written by you',
    writtenByYouBody: 'Edit it here; every machine gets the change.',
    uploadedByYou: 'Uploaded by you',
    foundOn: ({ machine }) => `Found on ${machine}`,
    foundOnBody: ({ path }) => path,
    firstParty: 'Built into Happier · follows its version',
    verifiedByDigest: 'Verified by digest',
    noDigestPublished: 'No digest published',
    added: ({ date }) => `added ${date}`,
    updates: 'Updates',
    upToDate: 'Up to date',
    updateAvailable: 'Update available',
    removedFromSource: 'Its source no longer has it',
    notChecked: 'Not checked yet',
    checked: ({ time }) => `checked ${time}`,
    checkNow: 'Check now',
    view: 'View',
    auto: 'Update automatically',
    autoBody: 'Off for skills from other people, so you see every change first',
    pin: 'Pin to this version',
    pinBody: 'Keep this version until you unpin it',
    checkFailed: 'Couldn’t check the source',
  },
  machines: {
    description: 'What each machine’s agents get right now.',
    nowhere: 'It isn’t on for any machine yet.',
    offline: 'Machine offline',
    lastKnown: ({ time }) => `last known ${time}`,
    masked: ({ agent, machine }) => `${agent}: ${machine}’s own copy wins`,
    cantLoad: ({ agents }) => `${agents} can’t load skills here`,
    previewFailed: ({ agent }) => `${agent}: —`,
    checking: 'Checking…',
    projectNote: 'Inside a project, the project’s own copy can still win.',
    noAgent: 'No agent here gets it',
    offlineCount: ({ count }) => `${count} offline`,
    summaryOn: ({ agents, machine }) => `${agents} on ${machine}`,
    summaryOnMany: ({ agents, count }) => `${agents} on ${count} machines`,
  },
  details: {
    title: 'Details',
    summary: 'Revision and copies outside Happier',
    revision: 'Revision',
    contentHash: 'Content hash',
    alsoInstall: ({ machine }) => `Also install on ${machine}`,
    alsoInstallBody:
      'For use outside Happier, in each agent’s own skills folder',
    installed: 'Installed',
    install: 'Install',
  },
  leave: {
    remove: 'Remove skill',
    footnote: 'Sessions running now keep it until they restart.',
    confirmTitle: ({ name }) => `Remove ${name}?`,
    confirmBody:
      'It leaves your library and every machine. Sessions running now keep it until they restart.',
    confirm: 'Remove',
  },
  draft: {
    title: 'New skill',
    purpose:
      'Teach your agents something once. They read the description to decide when to use it.',
    add: 'Add to library',
    adding: 'Adding…',
    addFailed: 'Couldn’t add the skill. Your text is kept.',
  },
};

const ca: SkillDetailTranslation = {
  whereDescription:
    'Configura-ho un cop i totes les màquines ho segueixen. Guanya la regla més específica.',
  tokensWhenUsed: ({ tokens }) => `${tokens} tokens quan es fa servir`,
  menu: {
    duplicate: 'Duplica',
    makeCopy: 'Fes una còpia editable',
    moveToFolder: 'Mou a una carpeta',
    noFolder: 'Sense carpeta',
    exportZip: 'Exporta com a .zip',
    copyLink: 'Copia l’enllaç',
    linkCopied: 'Enllaç copiat',
  },
  banner: {
    couldntLoadTitle: 'No s’ha pogut carregar aquesta habilitat',
    couldntLoadBody:
      'La teva biblioteca no ha respost. Les sessions conserven la còpia que ja tenen.',
  },
  instructions: {
    title: 'Instruccions',
    edit: 'Edita',
    done: 'Fet',
    preview: 'Previsualitza',
    showAll: 'Mostra-ho tot',
    showLess: 'Mostra’n menys',
    saving: 'Desant…',
    saved: 'Desat · s’aplica a les sessions noves',
    saveFailed: 'No s’ha pogut desar. El teu text es conserva.',
    conflict: 'Canviat en un altre dispositiu',
    reviewBoth: 'Revisa les dues',
    keepMine: 'Conserva la meva',
    takeTheirs: 'Agafa la seva',
    yours: 'La teva',
    theirs: 'La seva',
    lintOk: 'El nom i la descripció estan definits',
    lintMissingName: 'Afegeix un nom al frontmatter',
    lintMissingDescription:
      'Afegeix una descripció perquè els agents sàpiguen quan fer-la servir',
    lintNoFrontmatter: 'Comença amb un bloc frontmatter: nom i descripció',
    readOnlyPlugin: 'Ve amb el seu connector i en segueix la versió.',
  },
  files: {
    title: 'Fitxers',
    description: ({ count }) =>
      count === 1 ? '1 fitxer, sense scripts.' : `${count} fitxers, sense scripts.`,
    descriptionScripts: ({ count, scripts }) =>
      `${count} fitxers, ${scripts === 1 ? '1 s’executa com a script' : `${scripts} s’executen com a scripts`}.`,
    script: 'Script',
    addFile: 'Afegeix un fitxer',
    addFilePrompt: 'La seva ruta dins de l’habilitat.',
    addFilePlaceholder: 'reference/notes.md',
    remove: 'Treu',
    removeTitle: ({ path }) => `Vols treure ${path}?`,
    removeBody: 'Les sessions noves reben l’habilitat sense aquest fitxer.',
    more: ({ count }) => `${count} més`,
    binary: 'No és un fitxer de text',
    loading: 'Obrint…',
    afterAdd: 'Afegeix-hi més fitxers quan l’habilitat sigui a la teva biblioteca.',
  },
  source: {
    title: 'Origen i actualitzacions',
    descriptionReview: 'Els canvis de l’origen esperen la teva revisió.',
    descriptionAuto:
      'Els canvis de l’origen arriben sols, tret que l’hagis canviat.',
    descriptionPinned:
      'Fixada a una versió. Els canvis de l’origen esperen fins que la desfixis.',
    descriptionOwn: 'És teva. Només tu la canvies.',
    writtenByYou: 'Escrita per tu',
    writtenByYouBody: 'Edita-la aquí; totes les màquines reben el canvi.',
    uploadedByYou: 'Pujada per tu',
    foundOn: ({ machine }) => `Trobada a ${machine}`,
    foundOnBody: ({ path }) => path,
    firstParty: 'Integrada a Happier · en segueix la versió',
    verifiedByDigest: 'Verificada amb resum criptogràfic',
    noDigestPublished: 'Sense resum criptogràfic publicat',
    added: ({ date }) => `afegida ${date}`,
    updates: 'Actualitzacions',
    upToDate: 'Al dia',
    updateAvailable: 'Actualització disponible',
    removedFromSource: 'L’origen ja no la té',
    notChecked: 'Encara no comprovada',
    checked: ({ time }) => `comprovada ${time}`,
    checkNow: 'Comprova ara',
    view: 'Mostra',
    auto: 'Actualitza automàticament',
    autoBody:
      'Desactivat per a habilitats d’altres persones, així veus cada canvi primer',
    pin: 'Fixa a aquesta versió',
    pinBody: 'Conserva aquesta versió fins que la desfixis',
    checkFailed: 'No s’ha pogut comprovar l’origen',
  },
  machines: {
    description: 'El que reben ara els agents de cada màquina.',
    nowhere: 'Encara no està activada a cap màquina.',
    offline: 'Màquina fora de línia',
    lastKnown: ({ time }) => `últim estat ${time}`,
    masked: ({ agent, machine }) =>
      `${agent}: preval la còpia pròpia de ${machine}`,
    cantLoad: ({ agents }) => `${agents} no pot carregar habilitats aquí`,
    previewFailed: ({ agent }) => `${agent}: —`,
    checking: 'Comprovant…',
    projectNote:
      'Dins d’un projecte, la còpia pròpia del projecte encara pot guanyar.',
    noAgent: 'Cap agent d’aquí la rep',
    offlineCount: ({ count }) => `${count} fora de línia`,
    summaryOn: ({ agents, machine }) => `${agents} a ${machine}`,
    summaryOnMany: ({ agents, count }) => `${agents} a ${count} màquines`,
  },
  details: {
    title: 'Detalls',
    summary: 'Revisió i còpies fora de Happier',
    revision: 'Revisió',
    contentHash: 'Hash del contingut',
    alsoInstall: ({ machine }) => `Instal·la-la també a ${machine}`,
    alsoInstallBody:
      'Per fer-la servir fora de Happier, a la carpeta d’habilitats de cada agent',
    installed: 'Instal·lada',
    install: 'Instal·la',
  },
  leave: {
    remove: 'Treu l’habilitat',
    footnote: 'Les sessions en curs la conserven fins que es reiniciïn.',
    confirmTitle: ({ name }) => `Vols treure ${name}?`,
    confirmBody:
      'Surt de la teva biblioteca i de totes les màquines. Les sessions en curs la conserven fins que es reiniciïn.',
    confirm: 'Treu',
  },
  draft: {
    title: 'Habilitat nova',
    purpose:
      'Ensenya alguna cosa als teus agents un sol cop. Llegeixen la descripció per decidir quan fer-la servir.',
    add: 'Afegeix a la biblioteca',
    adding: 'Afegint…',
    addFailed: 'No s’ha pogut afegir l’habilitat. El teu text es conserva.',
  },
};

const de: SkillDetailTranslation = {
  whereDescription:
    'Einmal einstellen, und jede Maschine folgt. Die genaueste Regel gewinnt.',
  tokensWhenUsed: ({ tokens }) => `${tokens} Tokens bei Nutzung`,
  menu: {
    duplicate: 'Duplizieren',
    makeCopy: 'Bearbeitbare Kopie erstellen',
    moveToFolder: 'In Ordner verschieben',
    noFolder: 'Kein Ordner',
    exportZip: 'Als .zip exportieren',
    copyLink: 'Link kopieren',
    linkCopied: 'Link kopiert',
  },
  banner: {
    couldntLoadTitle: 'Dieser Skill konnte nicht geladen werden',
    couldntLoadBody:
      'Deine Bibliothek hat nicht geantwortet. Sitzungen behalten die Kopie, die sie schon haben.',
  },
  instructions: {
    title: 'Anweisungen',
    edit: 'Bearbeiten',
    done: 'Fertig',
    preview: 'Vorschau',
    showAll: 'Alle anzeigen',
    showLess: 'Weniger anzeigen',
    saving: 'Wird gespeichert…',
    saved: 'Gespeichert · gilt für neue Sitzungen',
    saveFailed: 'Konnte nicht gespeichert werden. Dein Text bleibt erhalten.',
    conflict: 'Auf einem anderen Gerät geändert',
    reviewBoth: 'Beide ansehen',
    keepMine: 'Meine behalten',
    takeTheirs: 'Andere übernehmen',
    yours: 'Deine',
    theirs: 'Andere',
    lintOk: 'Name und Beschreibung sind gesetzt',
    lintMissingName: 'Füge dem Frontmatter einen Namen hinzu',
    lintMissingDescription:
      'Füge eine Beschreibung hinzu, damit Agenten wissen, wann sie ihn nutzen',
    lintNoFrontmatter: 'Beginne mit einem Frontmatter-Block: Name und Beschreibung',
    readOnlyPlugin: 'Wird mit seinem Plugin geliefert und folgt dessen Version.',
  },
  files: {
    title: 'Dateien',
    description: ({ count }) =>
      count === 1 ? '1 Datei, keine Skripte.' : `${count} Dateien, keine Skripte.`,
    descriptionScripts: ({ count, scripts }) =>
      `${count} Dateien, ${scripts === 1 ? '1 läuft als Skript' : `${scripts} laufen als Skripte`}.`,
    script: 'Skript',
    addFile: 'Datei hinzufügen',
    addFilePrompt: 'Ihr Pfad im Skill.',
    addFilePlaceholder: 'reference/notes.md',
    remove: 'Entfernen',
    removeTitle: ({ path }) => `${path} entfernen?`,
    removeBody: 'Neue Sitzungen erhalten den Skill ohne diese Datei.',
    more: ({ count }) => `${count} weitere`,
    binary: 'Keine Textdatei',
    loading: 'Wird geöffnet…',
    afterAdd:
      'Füge weitere Dateien hinzu, sobald der Skill in deiner Bibliothek ist.',
  },
  source: {
    title: 'Quelle und Updates',
    descriptionReview: 'Änderungen aus der Quelle warten auf deine Prüfung.',
    descriptionAuto:
      'Änderungen aus der Quelle kommen von selbst, außer du hast ihn geändert.',
    descriptionPinned:
      'An eine Version angeheftet. Änderungen aus der Quelle warten, bis du ihn löst.',
    descriptionOwn: 'Gehört dir. Nur du änderst ihn.',
    writtenByYou: 'Von dir geschrieben',
    writtenByYouBody: 'Bearbeite ihn hier; jede Maschine bekommt die Änderung.',
    uploadedByYou: 'Von dir hochgeladen',
    foundOn: ({ machine }) => `Gefunden auf ${machine}`,
    foundOnBody: ({ path }) => path,
    firstParty: 'In Happier eingebaut · folgt dessen Version',
    verifiedByDigest: 'Per Prüfsumme verifiziert',
    noDigestPublished: 'Keine Prüfsumme veröffentlicht',
    added: ({ date }) => `hinzugefügt ${date}`,
    updates: 'Updates',
    upToDate: 'Aktuell',
    updateAvailable: 'Update verfügbar',
    removedFromSource: 'Seine Quelle hat ihn nicht mehr',
    notChecked: 'Noch nicht geprüft',
    checked: ({ time }) => `geprüft ${time}`,
    checkNow: 'Jetzt prüfen',
    view: 'Ansehen',
    auto: 'Automatisch aktualisieren',
    autoBody:
      'Aus bei Skills von anderen, damit du jede Änderung zuerst siehst',
    pin: 'An diese Version anheften',
    pinBody: 'Diese Version behalten, bis du sie löst',
    checkFailed: 'Quelle konnte nicht geprüft werden',
  },
  machines: {
    description: 'Was die Agenten jeder Maschine gerade bekommen.',
    nowhere: 'Er ist noch auf keiner Maschine an.',
    offline: 'Maschine offline',
    lastKnown: ({ time }) => `zuletzt bekannt ${time}`,
    masked: ({ agent, machine }) =>
      `${agent}: Die eigene Kopie von ${machine} gewinnt`,
    cantLoad: ({ agents }) => `${agents} kann hier keine Skills laden`,
    previewFailed: ({ agent }) => `${agent}: —`,
    checking: 'Wird geprüft…',
    projectNote:
      'In einem Projekt kann die eigene Kopie des Projekts trotzdem gewinnen.',
    noAgent: 'Kein Agent hier bekommt ihn',
    offlineCount: ({ count }) => `${count} offline`,
    summaryOn: ({ agents, machine }) => `${agents} auf ${machine}`,
    summaryOnMany: ({ agents, count }) => `${agents} auf ${count} Geräten`,
  },
  details: {
    title: 'Details',
    summary: 'Revision und Kopien außerhalb von Happier',
    revision: 'Revision',
    contentHash: 'Inhalts-Hash',
    alsoInstall: ({ machine }) => `Auch auf ${machine} installieren`,
    alsoInstallBody:
      'Zur Nutzung außerhalb von Happier, im eigenen Skills-Ordner jedes Agenten',
    installed: 'Installiert',
    install: 'Installieren',
  },
  leave: {
    remove: 'Skill entfernen',
    footnote: 'Laufende Sitzungen behalten ihn, bis sie neu starten.',
    confirmTitle: ({ name }) => `${name} entfernen?`,
    confirmBody:
      'Er verschwindet aus deiner Bibliothek und von jeder Maschine. Laufende Sitzungen behalten ihn, bis sie neu starten.',
    confirm: 'Entfernen',
  },
  draft: {
    title: 'Neuer Skill',
    purpose:
      'Bring deinen Agenten etwas einmal bei. Sie lesen die Beschreibung, um zu entscheiden, wann sie ihn nutzen.',
    add: 'Zur Bibliothek hinzufügen',
    adding: 'Wird hinzugefügt…',
    addFailed:
      'Der Skill konnte nicht hinzugefügt werden. Dein Text bleibt erhalten.',
  },
};

const es: SkillDetailTranslation = {
  whereDescription:
    'Configúrala una vez y todas las máquinas la siguen. Gana la regla más específica.',
  tokensWhenUsed: ({ tokens }) => `${tokens} tokens al usarse`,
  menu: {
    duplicate: 'Duplicar',
    makeCopy: 'Hacer una copia editable',
    moveToFolder: 'Mover a una carpeta',
    noFolder: 'Sin carpeta',
    exportZip: 'Exportar como .zip',
    copyLink: 'Copiar enlace',
    linkCopied: 'Enlace copiado',
  },
  banner: {
    couldntLoadTitle: 'No se pudo cargar esta habilidad',
    couldntLoadBody:
      'Tu biblioteca no respondió. Las sesiones conservan la copia que ya tienen.',
  },
  instructions: {
    title: 'Instrucciones',
    edit: 'Editar',
    done: 'Listo',
    preview: 'Vista previa',
    showAll: 'Mostrar todo',
    showLess: 'Mostrar menos',
    saving: 'Guardando…',
    saved: 'Guardado · se aplica a las sesiones nuevas',
    saveFailed: 'No se pudo guardar. Tu texto se conserva.',
    conflict: 'Cambiado en otro dispositivo',
    reviewBoth: 'Revisar ambas',
    keepMine: 'Quedarme con la mía',
    takeTheirs: 'Usar la otra',
    yours: 'La tuya',
    theirs: 'La otra',
    lintOk: 'El nombre y la descripción están definidos',
    lintMissingName: 'Añade un nombre al frontmatter',
    lintMissingDescription:
      'Añade una descripción para que los agentes sepan cuándo usarla',
    lintNoFrontmatter: 'Empieza con un bloque frontmatter: nombre y descripción',
    readOnlyPlugin: 'Viene con su plugin y sigue su versión.',
  },
  files: {
    title: 'Archivos',
    description: ({ count }) =>
      count === 1 ? '1 archivo, sin scripts.' : `${count} archivos, sin scripts.`,
    descriptionScripts: ({ count, scripts }) =>
      `${count} archivos, ${scripts === 1 ? '1 se ejecuta como script' : `${scripts} se ejecutan como scripts`}.`,
    script: 'Script',
    addFile: 'Añadir un archivo',
    addFilePrompt: 'Su ruta dentro de la habilidad.',
    addFilePlaceholder: 'reference/notes.md',
    remove: 'Quitar',
    removeTitle: ({ path }) => `¿Quitar ${path}?`,
    removeBody: 'Las sesiones nuevas reciben la habilidad sin él.',
    more: ({ count }) => `${count} más`,
    binary: 'No es un archivo de texto',
    loading: 'Abriendo…',
    afterAdd: 'Añade más archivos cuando la habilidad esté en tu biblioteca.',
  },
  source: {
    title: 'Origen y actualizaciones',
    descriptionReview: 'Los cambios del origen esperan tu revisión.',
    descriptionAuto:
      'Los cambios del origen llegan solos, salvo que la hayas cambiado.',
    descriptionPinned:
      'Fijada a una versión. Los cambios del origen esperan hasta que la desfijes.',
    descriptionOwn: 'Es tuya. Solo tú la cambias.',
    writtenByYou: 'Escrita por ti',
    writtenByYouBody: 'Edítala aquí; todas las máquinas reciben el cambio.',
    uploadedByYou: 'Subida por ti',
    foundOn: ({ machine }) => `Encontrada en ${machine}`,
    foundOnBody: ({ path }) => path,
    firstParty: 'Integrada en Happier · sigue su versión',
    verifiedByDigest: 'Verificada por resumen criptográfico',
    noDigestPublished: 'Sin resumen criptográfico publicado',
    added: ({ date }) => `añadida ${date}`,
    updates: 'Actualizaciones',
    upToDate: 'Al día',
    updateAvailable: 'Actualización disponible',
    removedFromSource: 'Su origen ya no la tiene',
    notChecked: 'Aún sin comprobar',
    checked: ({ time }) => `comprobada ${time}`,
    checkNow: 'Comprobar ahora',
    view: 'Ver',
    auto: 'Actualizar automáticamente',
    autoBody:
      'Desactivado para habilidades de otras personas, para que veas cada cambio primero',
    pin: 'Fijar a esta versión',
    pinBody: 'Mantener esta versión hasta que la desfijes',
    checkFailed: 'No se pudo comprobar el origen',
  },
  machines: {
    description: 'Lo que reciben ahora los agentes de cada máquina.',
    nowhere: 'Aún no está activada en ninguna máquina.',
    offline: 'Máquina sin conexión',
    lastKnown: ({ time }) => `último estado ${time}`,
    masked: ({ agent, machine }) =>
      `${agent}: gana la copia propia de ${machine}`,
    cantLoad: ({ agents }) => `${agents} no puede cargar habilidades aquí`,
    previewFailed: ({ agent }) => `${agent}: —`,
    checking: 'Comprobando…',
    projectNote:
      'Dentro de un proyecto, la copia propia del proyecto aún puede ganar.',
    noAgent: 'Ningún agente de aquí la recibe',
    offlineCount: ({ count }) => `${count} sin conexión`,
    summaryOn: ({ agents, machine }) => `${agents} en ${machine}`,
    summaryOnMany: ({ agents, count }) => `${agents} en ${count} máquinas`,
  },
  details: {
    title: 'Detalles',
    summary: 'Revisión y copias fuera de Happier',
    revision: 'Revisión',
    contentHash: 'Hash del contenido',
    alsoInstall: ({ machine }) => `Instalar también en ${machine}`,
    alsoInstallBody:
      'Para usarla fuera de Happier, en la carpeta de habilidades de cada agente',
    installed: 'Instalada',
    install: 'Instalar',
  },
  leave: {
    remove: 'Quitar habilidad',
    footnote: 'Las sesiones en marcha la conservan hasta que se reinicien.',
    confirmTitle: ({ name }) => `¿Quitar ${name}?`,
    confirmBody:
      'Sale de tu biblioteca y de todas las máquinas. Las sesiones en marcha la conservan hasta que se reinicien.',
    confirm: 'Quitar',
  },
  draft: {
    title: 'Habilidad nueva',
    purpose:
      'Enseña algo a tus agentes una sola vez. Leen la descripción para decidir cuándo usarla.',
    add: 'Añadir a la biblioteca',
    adding: 'Añadiendo…',
    addFailed: 'No se pudo añadir la habilidad. Tu texto se conserva.',
  },
};

const fr: SkillDetailTranslation = {
  whereDescription:
    'Réglez-le une fois et chaque machine suit. La règle la plus précise l’emporte.',
  tokensWhenUsed: ({ tokens }) => `${tokens} tokens à l’utilisation`,
  menu: {
    duplicate: 'Dupliquer',
    makeCopy: 'Faire une copie modifiable',
    moveToFolder: 'Déplacer vers un dossier',
    noFolder: 'Aucun dossier',
    exportZip: 'Exporter en .zip',
    copyLink: 'Copier le lien',
    linkCopied: 'Lien copié',
  },
  banner: {
    couldntLoadTitle: 'Impossible de charger ce skill',
    couldntLoadBody:
      'Votre bibliothèque n’a pas répondu. Les sessions gardent la copie qu’elles ont déjà.',
  },
  instructions: {
    title: 'Instructions',
    edit: 'Modifier',
    done: 'Terminé',
    preview: 'Aperçu',
    showAll: 'Tout afficher',
    showLess: 'Afficher moins',
    saving: 'Enregistrement…',
    saved: 'Enregistré · s’applique aux nouvelles sessions',
    saveFailed: 'Impossible d’enregistrer. Votre texte est conservé.',
    conflict: 'Modifié sur un autre appareil',
    reviewBoth: 'Voir les deux',
    keepMine: 'Garder le mien',
    takeTheirs: 'Prendre l’autre',
    yours: 'Le vôtre',
    theirs: 'L’autre',
    lintOk: 'Le nom et la description sont définis',
    lintMissingName: 'Ajoutez un nom au frontmatter',
    lintMissingDescription:
      'Ajoutez une description pour que les agents sachent quand l’utiliser',
    lintNoFrontmatter: 'Commencez par un bloc frontmatter : nom et description',
    readOnlyPlugin: 'Fourni avec son plugin, il suit sa version.',
  },
  files: {
    title: 'Fichiers',
    description: ({ count }) =>
      count === 1 ? '1 fichier, aucun script.' : `${count} fichiers, aucun script.`,
    descriptionScripts: ({ count, scripts }) =>
      `${count} fichiers, ${scripts === 1 ? '1 s’exécute comme script' : `${scripts} s’exécutent comme scripts`}.`,
    script: 'Script',
    addFile: 'Ajouter un fichier',
    addFilePrompt: 'Son chemin dans le skill.',
    addFilePlaceholder: 'reference/notes.md',
    remove: 'Retirer',
    removeTitle: ({ path }) => `Retirer ${path} ?`,
    removeBody: 'Les nouvelles sessions reçoivent le skill sans lui.',
    more: ({ count }) => `${count} de plus`,
    binary: 'Pas un fichier texte',
    loading: 'Ouverture…',
    afterAdd:
      'Ajoutez d’autres fichiers une fois le skill dans votre bibliothèque.',
  },
  source: {
    title: 'Source et mises à jour',
    descriptionReview: 'Les changements de la source attendent votre examen.',
    descriptionAuto:
      'Les changements de la source arrivent d’eux-mêmes, sauf si vous l’avez modifié.',
    descriptionPinned:
      'Épinglé sur une version. Les changements de la source attendent que vous le désépingliez.',
    descriptionOwn: 'À vous de le modifier. Rien ne le met à jour que vous.',
    writtenByYou: 'Écrit par vous',
    writtenByYouBody: 'Modifiez-le ici ; chaque machine reçoit le changement.',
    uploadedByYou: 'Importé par vous',
    foundOn: ({ machine }) => `Trouvé sur ${machine}`,
    foundOnBody: ({ path }) => path,
    firstParty: 'Intégré à Happier · suit sa version',
    verifiedByDigest: 'Vérifiée par empreinte',
    noDigestPublished: 'Aucune empreinte publiée',
    added: ({ date }) => `ajouté ${date}`,
    updates: 'Mises à jour',
    upToDate: 'À jour',
    updateAvailable: 'Mise à jour disponible',
    removedFromSource: 'Sa source ne l’a plus',
    notChecked: 'Pas encore vérifié',
    checked: ({ time }) => `vérifié ${time}`,
    checkNow: 'Vérifier maintenant',
    view: 'Voir',
    auto: 'Mettre à jour automatiquement',
    autoBody:
      'Désactivé pour les skills d’autres personnes, pour que vous voyiez chaque changement d’abord',
    pin: 'Épingler à cette version',
    pinBody: 'Garder cette version jusqu’à ce que vous la désépingliez',
    checkFailed: 'Impossible de vérifier la source',
  },
  machines: {
    description: 'Ce que reçoivent actuellement les agents de chaque machine.',
    nowhere: 'Il n’est encore activé sur aucune machine.',
    offline: 'Machine hors ligne',
    lastKnown: ({ time }) => `dernier état ${time}`,
    masked: ({ agent, machine }) =>
      `${agent} : la copie propre à ${machine} l’emporte`,
    cantLoad: ({ agents }) => `${agents} ne peut pas charger de skills ici`,
    previewFailed: ({ agent }) => `${agent} : —`,
    checking: 'Vérification…',
    projectNote:
      'Dans un projet, la copie propre au projet peut encore l’emporter.',
    noAgent: 'Aucun agent ici ne le reçoit',
    offlineCount: ({ count }) => `${count} hors ligne`,
    summaryOn: ({ agents, machine }) => `${agents} sur ${machine}`,
    summaryOnMany: ({ agents, count }) => `${agents} sur ${count} machines`,
  },
  details: {
    title: 'Détails',
    summary: 'Révision et copies hors de Happier',
    revision: 'Révision',
    contentHash: 'Hash du contenu',
    alsoInstall: ({ machine }) => `Installer aussi sur ${machine}`,
    alsoInstallBody:
      'Pour l’utiliser hors de Happier, dans le dossier de skills de chaque agent',
    installed: 'Installé',
    install: 'Installer',
  },
  leave: {
    remove: 'Retirer le skill',
    footnote: 'Les sessions en cours le gardent jusqu’à leur redémarrage.',
    confirmTitle: ({ name }) => `Retirer ${name} ?`,
    confirmBody:
      'Il quitte votre bibliothèque et chaque machine. Les sessions en cours le gardent jusqu’à leur redémarrage.',
    confirm: 'Retirer',
  },
  draft: {
    title: 'Nouveau skill',
    purpose:
      'Apprenez quelque chose à vos agents une seule fois. Ils lisent la description pour décider quand l’utiliser.',
    add: 'Ajouter à la bibliothèque',
    adding: 'Ajout…',
    addFailed: 'Impossible d’ajouter le skill. Votre texte est conservé.',
  },
};

const it: SkillDetailTranslation = {
  whereDescription:
    'Impostala una volta e ogni macchina la segue. Vince la regola più specifica.',
  tokensWhenUsed: ({ tokens }) => `${tokens} token quando viene usata`,
  menu: {
    duplicate: 'Duplica',
    makeCopy: 'Crea una copia modificabile',
    moveToFolder: 'Sposta in una cartella',
    noFolder: 'Nessuna cartella',
    exportZip: 'Esporta come .zip',
    copyLink: 'Copia link',
    linkCopied: 'Link copiato',
  },
  banner: {
    couldntLoadTitle: 'Impossibile caricare questa skill',
    couldntLoadBody:
      'La tua libreria non ha risposto. Le sessioni mantengono la copia che hanno già.',
  },
  instructions: {
    title: 'Istruzioni',
    edit: 'Modifica',
    done: 'Fatto',
    preview: 'Anteprima',
    showAll: 'Mostra tutto',
    showLess: 'Mostra meno',
    saving: 'Salvataggio…',
    saved: 'Salvato · vale per le nuove sessioni',
    saveFailed: 'Impossibile salvare. Il tuo testo è conservato.',
    conflict: 'Modificata su un altro dispositivo',
    reviewBoth: 'Rivedi entrambe',
    keepMine: 'Tieni la mia',
    takeTheirs: 'Prendi l’altra',
    yours: 'La tua',
    theirs: 'L’altra',
    lintOk: 'Nome e descrizione sono impostati',
    lintMissingName: 'Aggiungi un nome al frontmatter',
    lintMissingDescription:
      'Aggiungi una descrizione, così gli agenti sanno quando usarla',
    lintNoFrontmatter: 'Inizia con un blocco frontmatter: nome e descrizione',
    readOnlyPlugin: 'Inclusa nel suo plugin, ne segue la versione.',
  },
  files: {
    title: 'File',
    description: ({ count }) =>
      count === 1 ? '1 file, nessuno script.' : `${count} file, nessuno script.`,
    descriptionScripts: ({ count, scripts }) =>
      `${count} file, ${scripts === 1 ? '1 viene eseguito come script' : `${scripts} vengono eseguiti come script`}.`,
    script: 'Script',
    addFile: 'Aggiungi un file',
    addFilePrompt: 'Il suo percorso dentro la skill.',
    addFilePlaceholder: 'reference/notes.md',
    remove: 'Rimuovi',
    removeTitle: ({ path }) => `Rimuovere ${path}?`,
    removeBody: 'Le nuove sessioni ricevono la skill senza questo file.',
    more: ({ count }) => `Altri ${count}`,
    binary: 'Non è un file di testo',
    loading: 'Apertura…',
    afterAdd: 'Aggiungi altri file quando la skill è nella tua libreria.',
  },
  source: {
    title: 'Fonte e aggiornamenti',
    descriptionReview: 'Le modifiche dalla fonte aspettano la tua revisione.',
    descriptionAuto:
      'Le modifiche dalla fonte arrivano da sole, a meno che tu non l’abbia modificata.',
    descriptionPinned:
      'Bloccata su una versione. Le modifiche dalla fonte aspettano finché non la sblocchi.',
    descriptionOwn: 'È tua. Solo tu la modifichi.',
    writtenByYou: 'Scritta da te',
    writtenByYouBody: 'Modificala qui; ogni macchina riceve la modifica.',
    uploadedByYou: 'Caricata da te',
    foundOn: ({ machine }) => `Trovata su ${machine}`,
    foundOnBody: ({ path }) => path,
    firstParty: 'Integrata in Happier · ne segue la versione',
    verifiedByDigest: 'Verificata tramite digest',
    noDigestPublished: 'Nessun digest pubblicato',
    added: ({ date }) => `aggiunta ${date}`,
    updates: 'Aggiornamenti',
    upToDate: 'Aggiornata',
    updateAvailable: 'Aggiornamento disponibile',
    removedFromSource: 'La sua fonte non l’ha più',
    notChecked: 'Non ancora controllata',
    checked: ({ time }) => `controllata ${time}`,
    checkNow: 'Controlla ora',
    view: 'Vedi',
    auto: 'Aggiorna automaticamente',
    autoBody:
      'Disattivato per le skill di altre persone, così vedi ogni modifica prima',
    pin: 'Blocca su questa versione',
    pinBody: 'Mantieni questa versione finché non la sblocchi',
    checkFailed: 'Impossibile controllare la fonte',
  },
  machines: {
    description: 'Cosa ricevono ora gli agenti di ogni macchina.',
    nowhere: 'Non è ancora attiva su nessuna macchina.',
    offline: 'Macchina offline',
    lastKnown: ({ time }) => `ultimo stato ${time}`,
    masked: ({ agent, machine }) =>
      `${agent}: vince la copia propria di ${machine}`,
    cantLoad: ({ agents }) => `${agents} non può caricare skill qui`,
    previewFailed: ({ agent }) => `${agent}: —`,
    checking: 'Controllo…',
    projectNote:
      'In un progetto, la copia propria del progetto può ancora vincere.',
    noAgent: 'Nessun agente qui la riceve',
    offlineCount: ({ count }) => `${count} offline`,
    summaryOn: ({ agents, machine }) => `${agents} su ${machine}`,
    summaryOnMany: ({ agents, count }) => `${agents} su ${count} macchine`,
  },
  details: {
    title: 'Dettagli',
    summary: 'Revisione e copie fuori da Happier',
    revision: 'Revisione',
    contentHash: 'Hash del contenuto',
    alsoInstall: ({ machine }) => `Installa anche su ${machine}`,
    alsoInstallBody:
      'Per usarla fuori da Happier, nella cartella delle skill di ogni agente',
    installed: 'Installata',
    install: 'Installa',
  },
  leave: {
    remove: 'Rimuovi skill',
    footnote: 'Le sessioni in corso la mantengono finché non si riavviano.',
    confirmTitle: ({ name }) => `Rimuovere ${name}?`,
    confirmBody:
      'Esce dalla tua libreria e da ogni macchina. Le sessioni in corso la mantengono finché non si riavviano.',
    confirm: 'Rimuovi',
  },
  draft: {
    title: 'Nuova skill',
    purpose:
      'Insegna qualcosa ai tuoi agenti una volta sola. Leggono la descrizione per decidere quando usarla.',
    add: 'Aggiungi alla libreria',
    adding: 'Aggiunta…',
    addFailed: 'Impossibile aggiungere la skill. Il tuo testo è conservato.',
  },
};

const ja: SkillDetailTranslation = {
  whereDescription:
    '一度設定すれば、すべてのマシンが従います。最も具体的なルールが優先されます。',
  tokensWhenUsed: ({ tokens }) => `使用時 ${tokens} トークン`,
  menu: {
    duplicate: '複製',
    makeCopy: '編集可能なコピーを作成',
    moveToFolder: 'フォルダーに移動',
    noFolder: 'フォルダーなし',
    exportZip: '.zip として書き出す',
    copyLink: 'リンクをコピー',
    linkCopied: 'リンクをコピーしました',
  },
  banner: {
    couldntLoadTitle: 'このスキルを読み込めませんでした',
    couldntLoadBody:
      'ライブラリから応答がありませんでした。セッションは、すでに持っているコピーを使い続けます。',
  },
  instructions: {
    title: '指示',
    edit: '編集',
    done: '完了',
    preview: 'プレビュー',
    showAll: 'すべて表示',
    showLess: '表示を減らす',
    saving: '保存中…',
    saved: '保存しました · 新しいセッションに適用',
    saveFailed: '保存できませんでした。入力したテキストは残っています。',
    conflict: '別のデバイスで変更されました',
    reviewBoth: '両方を確認',
    keepMine: '自分のを残す',
    takeTheirs: '相手のを使う',
    yours: '自分',
    theirs: '相手',
    lintOk: '名前と説明が設定されています',
    lintMissingName: 'frontmatter に名前を追加してください',
    lintMissingDescription:
      'エージェントが使うタイミングを判断できるよう、説明を追加してください',
    lintNoFrontmatter: 'frontmatter ブロックで始めてください：名前と説明',
    readOnlyPlugin: 'プラグインに付属し、そのバージョンに従います。',
  },
  files: {
    title: 'ファイル',
    description: ({ count }) =>
      count === 1 ? '1 件のファイル、スクリプトなし。' : `${count} 件のファイル、スクリプトなし。`,
    descriptionScripts: ({ count, scripts }) =>
      `${count} 件のファイル、${scripts} 件はスクリプトとして実行されます。`,
    script: 'スクリプト',
    addFile: 'ファイルを追加',
    addFilePrompt: 'スキル内でのパスです。',
    addFilePlaceholder: 'reference/notes.md',
    remove: '削除',
    removeTitle: ({ path }) => `${path} を削除しますか？`,
    removeBody: '新しいセッションは、このファイルなしでスキルを受け取ります。',
    more: ({ count }) => `ほか ${count} 件`,
    binary: 'テキストファイルではありません',
    loading: '開いています…',
    afterAdd: 'スキルがライブラリに入ったら、ファイルを追加できます。',
  },
  source: {
    title: 'ソースとアップデート',
    descriptionReview: 'ソースからの変更は、あなたの確認を待ちます。',
    descriptionAuto:
      'ソースからの変更は自動で届きます。ただし、あなたが変更したスキルは除きます。',
    descriptionPinned:
      'バージョンを固定中です。固定を外すまで、ソースからの変更は待機します。',
    descriptionOwn: 'あなたのスキルです。あなた以外は更新しません。',
    writtenByYou: 'あなたが作成',
    writtenByYouBody: 'ここで編集すると、すべてのマシンに反映されます。',
    uploadedByYou: 'あなたがアップロード',
    foundOn: ({ machine }) => `${machine} で見つかりました`,
    foundOnBody: ({ path }) => path,
    firstParty: 'Happier に内蔵 · そのバージョンに従います',
    verifiedByDigest: 'ダイジェストで検証済み',
    noDigestPublished: 'ダイジェスト未公開',
    added: ({ date }) => `${date} に追加`,
    updates: 'アップデート',
    upToDate: '最新です',
    updateAvailable: 'アップデートあり',
    removedFromSource: '取得元から削除されています',
    notChecked: 'まだ確認していません',
    checked: ({ time }) => `${time} に確認`,
    checkNow: '今すぐ確認',
    view: '表示',
    auto: '自動で更新',
    autoBody: '他の人のスキルではオフです。すべての変更を先に確認できます',
    pin: 'このバージョンに固定',
    pinBody: '固定を外すまでこのバージョンを保ちます',
    checkFailed: '取得元を確認できませんでした',
  },
  machines: {
    description: '各マシンのエージェントが、いま受け取っているものです。',
    nowhere: 'まだどのマシンでもオンになっていません。',
    offline: 'マシンはオフライン',
    lastKnown: ({ time }) => `最終確認 ${time}`,
    masked: ({ agent, machine }) =>
      `${agent}：${machine} 自身のコピーが優先されます`,
    cantLoad: ({ agents }) => `${agents}はここでスキルを読み込めません`,
    previewFailed: ({ agent }) => `${agent}：—`,
    checking: '確認中…',
    projectNote:
      'プロジェクト内では、プロジェクト自身のコピーが優先されることがあります。',
    noAgent: 'ここにはスキルを受け取るエージェントがいません',
    offlineCount: ({ count }) => `オフライン ${count} 台`,
    summaryOn: ({ agents, machine }) => `${machine}: ${agents}`,
    summaryOnMany: ({ agents, count }) => `${count} 台: ${agents}`,
  },
  details: {
    title: '詳細',
    summary: 'リビジョンと Happier 外のコピー',
    revision: 'リビジョン',
    contentHash: 'コンテンツハッシュ',
    alsoInstall: ({ machine }) => `${machine} にもインストール`,
    alsoInstallBody:
      'Happier の外で使うため、各エージェント自身のスキルフォルダーに入れます',
    installed: 'インストール済み',
    install: 'インストール',
  },
  leave: {
    remove: 'スキルを削除',
    footnote: '実行中のセッションは、再起動するまで引き続き使えます。',
    confirmTitle: ({ name }) => `${name} を削除しますか？`,
    confirmBody:
      'ライブラリとすべてのマシンから外れます。実行中のセッションは、再起動するまで引き続き使えます。',
    confirm: '削除',
  },
  draft: {
    title: '新しいスキル',
    purpose:
      '一度教えるだけで十分です。エージェントは説明を読んで、使うタイミングを判断します。',
    add: 'ライブラリに追加',
    adding: '追加中…',
    addFailed: 'スキルを追加できませんでした。入力したテキストは残っています。',
  },
};

const pl: SkillDetailTranslation = {
  whereDescription:
    'Ustaw raz, a każda maszyna się dostosuje. Wygrywa najbardziej szczegółowa reguła.',
  tokensWhenUsed: ({ tokens }) => `${tokens} tokenów przy użyciu`,
  menu: {
    duplicate: 'Duplikuj',
    makeCopy: 'Utwórz edytowalną kopię',
    moveToFolder: 'Przenieś do folderu',
    noFolder: 'Bez folderu',
    exportZip: 'Eksportuj jako .zip',
    copyLink: 'Kopiuj link',
    linkCopied: 'Skopiowano link',
  },
  banner: {
    couldntLoadTitle: 'Nie udało się wczytać tej umiejętności',
    couldntLoadBody:
      'Twoja biblioteka nie odpowiedziała. Sesje zachowują kopię, którą już mają.',
  },
  instructions: {
    title: 'Instrukcje',
    edit: 'Edytuj',
    done: 'Gotowe',
    preview: 'Podgląd',
    showAll: 'Pokaż wszystko',
    showLess: 'Pokaż mniej',
    saving: 'Zapisywanie…',
    saved: 'Zapisano · dotyczy nowych sesji',
    saveFailed: 'Nie udało się zapisać. Twój tekst został zachowany.',
    conflict: 'Zmieniono na innym urządzeniu',
    reviewBoth: 'Porównaj obie',
    keepMine: 'Zostaw moją',
    takeTheirs: 'Weź tamtą',
    yours: 'Twoja',
    theirs: 'Tamta',
    lintOk: 'Nazwa i opis są ustawione',
    lintMissingName: 'Dodaj nazwę we frontmatter',
    lintMissingDescription:
      'Dodaj opis, żeby agenci wiedzieli, kiedy jej użyć',
    lintNoFrontmatter: 'Zacznij od bloku frontmatter: nazwa i opis',
    readOnlyPlugin: 'Jest częścią swojej wtyczki i podąża za jej wersją.',
  },
  files: {
    title: 'Pliki',
    description: ({ count }) => `Pliki: ${count}, bez skryptów.`,
    descriptionScripts: ({ count, scripts }) =>
      `Pliki: ${count}, w tym skrypty: ${scripts}.`,
    script: 'Skrypt',
    addFile: 'Dodaj plik',
    addFilePrompt: 'Jego ścieżka wewnątrz umiejętności.',
    addFilePlaceholder: 'reference/notes.md',
    remove: 'Usuń',
    removeTitle: ({ path }) => `Usunąć ${path}?`,
    removeBody: 'Nowe sesje dostaną umiejętność bez niego.',
    more: ({ count }) => `Jeszcze ${count}`,
    binary: 'To nie jest plik tekstowy',
    loading: 'Otwieranie…',
    afterAdd: 'Dodaj więcej plików, gdy umiejętność trafi do biblioteki.',
  },
  source: {
    title: 'Źródło i aktualizacje',
    descriptionReview: 'Zmiany ze źródła czekają na twój przegląd.',
    descriptionAuto:
      'Zmiany ze źródła docierają same, o ile nie edytowano jej u ciebie.',
    descriptionPinned:
      'Przypięta do wersji. Zmiany ze źródła czekają, aż ją odepniesz.',
    descriptionOwn: 'Jest twoja. Nic jej nie zmienia poza tobą.',
    writtenByYou: 'Napisana przez ciebie',
    writtenByYouBody: 'Edytuj ją tutaj; każda maszyna dostanie zmianę.',
    uploadedByYou: 'Przesłana przez ciebie',
    foundOn: ({ machine }) => `Znaleziona na ${machine}`,
    foundOnBody: ({ path }) => path,
    firstParty: 'Wbudowana w Happier · podąża za jego wersją',
    verifiedByDigest: 'Zweryfikowana skrótem',
    noDigestPublished: 'Nie opublikowano skrótu',
    added: ({ date }) => `dodano ${date}`,
    updates: 'Aktualizacje',
    upToDate: 'Aktualna',
    updateAvailable: 'Dostępna aktualizacja',
    removedFromSource: 'Źródło już jej nie ma',
    notChecked: 'Jeszcze nie sprawdzono',
    checked: ({ time }) => `sprawdzono ${time}`,
    checkNow: 'Sprawdź teraz',
    view: 'Zobacz',
    auto: 'Aktualizuj automatycznie',
    autoBody:
      'Wyłączone dla umiejętności od innych osób, aby każda zmiana najpierw czekała na twój przegląd',
    pin: 'Przypnij do tej wersji',
    pinBody: 'Zostań przy tej wersji, aż ją odepniesz',
    checkFailed: 'Nie udało się sprawdzić źródła',
  },
  machines: {
    description: 'Co teraz dostają agenci na każdej maszynie.',
    nowhere: 'Nie jest jeszcze włączona na żadnej maszynie.',
    offline: 'Maszyna offline',
    lastKnown: ({ time }) => `ostatni stan ${time}`,
    masked: ({ agent, machine }) =>
      `${agent}: wygrywa własna kopia z ${machine}`,
    cantLoad: ({ agents }) => `${agents} nie obsługuje tu umiejętności`,
    previewFailed: ({ agent }) => `${agent}: —`,
    checking: 'Sprawdzanie…',
    projectNote: 'W projekcie nadal może wygrać własna kopia projektu.',
    noAgent: 'Żaden agent tutaj jej nie dostaje',
    offlineCount: ({ count }) => `Offline: ${count}`,
    summaryOn: ({ agents, machine }) => `${agents} na ${machine}`,
    summaryOnMany: ({ agents, count }) => `${agents} na maszynach: ${count}`,
  },
  details: {
    title: 'Szczegóły',
    summary: 'Rewizja i kopie poza Happier',
    revision: 'Rewizja',
    contentHash: 'Skrót zawartości',
    alsoInstall: ({ machine }) => `Zainstaluj też na ${machine}`,
    alsoInstallBody:
      'Do użycia poza Happier, w folderze umiejętności każdego agenta',
    installed: 'Zainstalowana',
    install: 'Zainstaluj',
  },
  leave: {
    remove: 'Usuń umiejętność',
    footnote: 'Trwające sesje zachowują ją do ponownego uruchomienia.',
    confirmTitle: ({ name }) => `Usunąć ${name}?`,
    confirmBody:
      'Znika z twojej biblioteki i ze wszystkich maszyn. Trwające sesje zachowują ją do ponownego uruchomienia.',
    confirm: 'Usuń',
  },
  draft: {
    title: 'Nowa umiejętność',
    purpose:
      'Naucz agentów czegoś raz. Czytają opis, żeby zdecydować, kiedy jej użyć.',
    add: 'Dodaj do biblioteki',
    adding: 'Dodawanie…',
    addFailed: 'Nie udało się dodać umiejętności. Twój tekst został zachowany.',
  },
};

const pt: SkillDetailTranslation = {
  whereDescription:
    'Defina uma vez e todas as máquinas seguem. Ganha a regra mais específica.',
  tokensWhenUsed: ({ tokens }) => `${tokens} tokens quando é usada`,
  menu: {
    duplicate: 'Duplicar',
    makeCopy: 'Fazer uma cópia editável',
    moveToFolder: 'Mover para uma pasta',
    noFolder: 'Sem pasta',
    exportZip: 'Exportar como .zip',
    copyLink: 'Copiar link',
    linkCopied: 'Link copiado',
  },
  banner: {
    couldntLoadTitle: 'Não foi possível carregar esta habilidade',
    couldntLoadBody:
      'A sua biblioteca não respondeu. As sessões mantêm a cópia que já têm.',
  },
  instructions: {
    title: 'Instruções',
    edit: 'Editar',
    done: 'Concluir',
    preview: 'Pré-visualizar',
    showAll: 'Mostrar tudo',
    showLess: 'Mostrar menos',
    saving: 'A guardar…',
    saved: 'Guardado · aplica-se às novas sessões',
    saveFailed: 'Não foi possível guardar. O seu texto foi mantido.',
    conflict: 'Alterada noutro dispositivo',
    reviewBoth: 'Rever ambas',
    keepMine: 'Manter a minha',
    takeTheirs: 'Usar a outra',
    yours: 'A sua',
    theirs: 'A outra',
    lintOk: 'O nome e a descrição estão definidos',
    lintMissingName: 'Adicione um nome ao frontmatter',
    lintMissingDescription:
      'Adicione uma descrição, para os agentes saberem quando a usar',
    lintNoFrontmatter: 'Comece com um bloco frontmatter: nome e descrição',
    readOnlyPlugin: 'Vem com o seu plug-in e acompanha a sua versão.',
  },
  files: {
    title: 'Ficheiros',
    description: ({ count }) =>
      count === 1 ? '1 ficheiro, sem scripts.' : `${count} ficheiros, sem scripts.`,
    descriptionScripts: ({ count, scripts }) =>
      `${count} ficheiros, ${scripts === 1 ? '1 corre como script' : `${scripts} correm como scripts`}.`,
    script: 'Script',
    addFile: 'Adicionar um ficheiro',
    addFilePrompt: 'O seu caminho dentro da habilidade.',
    addFilePlaceholder: 'reference/notes.md',
    remove: 'Remover',
    removeTitle: ({ path }) => `Remover ${path}?`,
    removeBody: 'As novas sessões recebem a habilidade sem ele.',
    more: ({ count }) => `Mais ${count}`,
    binary: 'Não é um ficheiro de texto',
    loading: 'A abrir…',
    afterAdd:
      'Adicione mais ficheiros quando a habilidade estiver na sua biblioteca.',
  },
  source: {
    title: 'Origem e atualizações',
    descriptionReview: 'As alterações da origem aguardam a sua revisão.',
    descriptionAuto:
      'As alterações da origem chegam sozinhas, a menos que a tenha alterado.',
    descriptionPinned:
      'Fixada numa versão. As alterações da origem aguardam até a desafixar.',
    descriptionOwn: 'É sua. Só você a altera.',
    writtenByYou: 'Escrita por si',
    writtenByYouBody: 'Edite-a aqui; todas as máquinas recebem a alteração.',
    uploadedByYou: 'Carregada por si',
    foundOn: ({ machine }) => `Encontrada em ${machine}`,
    foundOnBody: ({ path }) => path,
    firstParty: 'Integrada no Happier · acompanha a sua versão',
    verifiedByDigest: 'Verificada por resumo criptográfico',
    noDigestPublished: 'Nenhum resumo criptográfico publicado',
    added: ({ date }) => `adicionada ${date}`,
    updates: 'Atualizações',
    upToDate: 'Atualizada',
    updateAvailable: 'Atualização disponível',
    removedFromSource: 'A origem já não a tem',
    notChecked: 'Ainda não verificada',
    checked: ({ time }) => `verificada ${time}`,
    checkNow: 'Verificar agora',
    view: 'Ver',
    auto: 'Atualizar automaticamente',
    autoBody:
      'Desativado para habilidades de outras pessoas, para ver cada alteração primeiro',
    pin: 'Fixar nesta versão',
    pinBody: 'Manter esta versão até a desafixar',
    checkFailed: 'Não foi possível verificar a origem',
  },
  machines: {
    description: 'O que os agentes de cada máquina recebem neste momento.',
    nowhere: 'Ainda não está ativada em nenhuma máquina.',
    offline: 'Máquina offline',
    lastKnown: ({ time }) => `último estado ${time}`,
    masked: ({ agent, machine }) =>
      `${agent}: ganha a cópia própria de ${machine}`,
    cantLoad: ({ agents }) => `${agents} não pode carregar habilidades aqui`,
    previewFailed: ({ agent }) => `${agent}: —`,
    checking: 'A verificar…',
    projectNote:
      'Dentro de um projeto, a cópia própria do projeto ainda pode ganhar.',
    noAgent: 'Nenhum agente aqui a recebe',
    offlineCount: ({ count }) => `${count} offline`,
    summaryOn: ({ agents, machine }) => `${agents} em ${machine}`,
    summaryOnMany: ({ agents, count }) => `${agents} em ${count} máquinas`,
  },
  details: {
    title: 'Detalhes',
    summary: 'Revisão e cópias fora do Happier',
    revision: 'Revisão',
    contentHash: 'Hash do conteúdo',
    alsoInstall: ({ machine }) => `Instalar também em ${machine}`,
    alsoInstallBody:
      'Para usar fora do Happier, na pasta de habilidades de cada agente',
    installed: 'Instalada',
    install: 'Instalar',
  },
  leave: {
    remove: 'Remover habilidade',
    footnote: 'As sessões em curso mantêm-na até reiniciarem.',
    confirmTitle: ({ name }) => `Remover ${name}?`,
    confirmBody:
      'Sai da sua biblioteca e de todas as máquinas. As sessões em curso mantêm-na até reiniciarem.',
    confirm: 'Remover',
  },
  draft: {
    title: 'Nova habilidade',
    purpose:
      'Ensine algo aos seus agentes uma só vez. Eles leem a descrição para decidir quando a usar.',
    add: 'Adicionar à biblioteca',
    adding: 'A adicionar…',
    addFailed: 'Não foi possível adicionar a habilidade. O seu texto foi mantido.',
  },
};

const ru: SkillDetailTranslation = {
  whereDescription:
    'Настройте один раз — и каждая машина последует. Побеждает самое точное правило.',
  tokensWhenUsed: ({ tokens }) => `${tokens} токенов при использовании`,
  menu: {
    duplicate: 'Дублировать',
    makeCopy: 'Сделать редактируемую копию',
    moveToFolder: 'Переместить в папку',
    noFolder: 'Без папки',
    exportZip: 'Экспортировать как .zip',
    copyLink: 'Копировать ссылку',
    linkCopied: 'Ссылка скопирована',
  },
  banner: {
    couldntLoadTitle: 'Не удалось загрузить этот скилл',
    couldntLoadBody:
      'Ваша библиотека не ответила. Сессии сохраняют уже имеющуюся копию.',
  },
  instructions: {
    title: 'Инструкции',
    edit: 'Изменить',
    done: 'Готово',
    preview: 'Предпросмотр',
    showAll: 'Показать всё',
    showLess: 'Показать меньше',
    saving: 'Сохранение…',
    saved: 'Сохранено · применится к новым сессиям',
    saveFailed: 'Не удалось сохранить. Ваш текст сохранён.',
    conflict: 'Изменено на другом устройстве',
    reviewBoth: 'Сравнить оба',
    keepMine: 'Оставить мой',
    takeTheirs: 'Взять другой',
    yours: 'Ваш',
    theirs: 'Другой',
    lintOk: 'Имя и описание заданы',
    lintMissingName: 'Добавьте имя во frontmatter',
    lintMissingDescription:
      'Добавьте описание, чтобы агенты знали, когда его использовать',
    lintNoFrontmatter: 'Начните с блока frontmatter: имя и описание',
    readOnlyPlugin: 'Входит в свой плагин и следует его версии.',
  },
  files: {
    title: 'Файлы',
    description: ({ count }) => `Файлов: ${count}, без скриптов.`,
    descriptionScripts: ({ count, scripts }) =>
      `Файлов: ${count}, из них скриптов: ${scripts}.`,
    script: 'Скрипт',
    addFile: 'Добавить файл',
    addFilePrompt: 'Его путь внутри скилла.',
    addFilePlaceholder: 'reference/notes.md',
    remove: 'Удалить',
    removeTitle: ({ path }) => `Удалить ${path}?`,
    removeBody: 'Новые сессии получат скилл без него.',
    more: ({ count }) => `Ещё ${count}`,
    binary: 'Не текстовый файл',
    loading: 'Открывается…',
    afterAdd: 'Добавляйте файлы, когда скилл окажется в вашей библиотеке.',
  },
  source: {
    title: 'Источник и обновления',
    descriptionReview: 'Изменения из источника ждут вашей проверки.',
    descriptionAuto:
      'Изменения из источника приходят сами, если вы его не меняли.',
    descriptionPinned:
      'Закреплён на версии. Изменения из источника ждут, пока вы не открепите.',
    descriptionOwn: 'Он ваш. Обновляете его только вы.',
    writtenByYou: 'Написан вами',
    writtenByYouBody: 'Правьте его здесь — каждая машина получит изменение.',
    uploadedByYou: 'Загружен вами',
    foundOn: ({ machine }) => `Найден на ${machine}`,
    foundOnBody: ({ path }) => path,
    firstParty: 'Встроен в Happier · следует его версии',
    verifiedByDigest: 'Проверено по хешу',
    noDigestPublished: 'Хеш не опубликован',
    added: ({ date }) => `добавлен ${date}`,
    updates: 'Обновления',
    upToDate: 'Актуальная версия',
    updateAvailable: 'Есть обновление',
    removedFromSource: 'В источнике его больше нет',
    notChecked: 'Ещё не проверялся',
    checked: ({ time }) => `проверено ${time}`,
    checkNow: 'Проверить сейчас',
    view: 'Посмотреть',
    auto: 'Обновлять автоматически',
    autoBody:
      'Выключено для чужих скиллов, чтобы вы сначала видели каждое изменение',
    pin: 'Закрепить эту версию',
    pinBody: 'Оставить эту версию, пока вы не открепите',
    checkFailed: 'Не удалось проверить источник',
  },
  machines: {
    description: 'Что сейчас получают агенты на каждой машине.',
    nowhere: 'Пока не включён ни на одной машине.',
    offline: 'Машина не в сети',
    lastKnown: ({ time }) => `последнее состояние ${time}`,
    masked: ({ agent, machine }) =>
      `${agent}: побеждает собственная копия на ${machine}`,
    cantLoad: ({ agents }) => `${agents} не умеет загружать скиллы здесь`,
    previewFailed: ({ agent }) => `${agent}: —`,
    checking: 'Проверка…',
    projectNote:
      'Внутри проекта всё ещё может победить собственная копия проекта.',
    noAgent: 'Ни один агент здесь его не получает',
    offlineCount: ({ count }) => `Не в сети: ${count}`,
    summaryOn: ({ agents, machine }) => `${agents} на ${machine}`,
    summaryOnMany: ({ agents, count }) => `${agents} на устройствах: ${count}`,
  },
  details: {
    title: 'Подробности',
    summary: 'Ревизия и копии вне Happier',
    revision: 'Ревизия',
    contentHash: 'Хеш содержимого',
    alsoInstall: ({ machine }) => `Установить также на ${machine}`,
    alsoInstallBody:
      'Для использования вне Happier, в папке скиллов каждого агента',
    installed: 'Установлен',
    install: 'Установить',
  },
  leave: {
    remove: 'Удалить скилл',
    footnote: 'Запущенные сессии сохранят его до перезапуска.',
    confirmTitle: ({ name }) => `Удалить ${name}?`,
    confirmBody:
      'Он исчезнет из вашей библиотеки и со всех машин. Запущенные сессии сохранят его до перезапуска.',
    confirm: 'Удалить',
  },
  draft: {
    title: 'Новый скилл',
    purpose:
      'Научите агентов чему-то один раз. Они читают описание, чтобы решить, когда его использовать.',
    add: 'Добавить в библиотеку',
    adding: 'Добавление…',
    addFailed: 'Не удалось добавить скилл. Ваш текст сохранён.',
  },
};

const zhHans: SkillDetailTranslation = {
  whereDescription: '设置一次，每台机器都会跟随。最具体的规则优先。',
  tokensWhenUsed: ({ tokens }) => `使用时 ${tokens} 个 token`,
  menu: {
    duplicate: '复制',
    makeCopy: '创建可编辑副本',
    moveToFolder: '移到文件夹',
    noFolder: '无文件夹',
    exportZip: '导出为 .zip',
    copyLink: '复制链接',
    linkCopied: '链接已复制',
  },
  banner: {
    couldntLoadTitle: '无法加载此技能',
    couldntLoadBody: '你的资料库没有响应。会话会继续使用已有的副本。',
  },
  instructions: {
    title: '指令',
    edit: '编辑',
    done: '完成',
    preview: '预览',
    showAll: '显示全部',
    showLess: '收起',
    saving: '正在保存…',
    saved: '已保存 · 适用于新会话',
    saveFailed: '无法保存。你的文本已保留。',
    conflict: '已在另一台设备上更改',
    reviewBoth: '查看两者',
    keepMine: '保留我的',
    takeTheirs: '采用对方的',
    yours: '你的',
    theirs: '对方的',
    lintOk: '名称和描述已设置',
    lintMissingName: '在 frontmatter 中添加名称',
    lintMissingDescription: '添加描述，让智能体知道何时使用',
    lintNoFrontmatter: '以 frontmatter 块开头：名称和描述',
    readOnlyPlugin: '随其插件提供，并跟随插件版本。',
  },
  files: {
    title: '文件',
    description: ({ count }) =>
      count === 1 ? '1 个文件，没有脚本。' : `${count} 个文件，没有脚本。`,
    descriptionScripts: ({ count, scripts }) =>
      `${count} 个文件，其中 ${scripts} 个作为脚本运行。`,
    script: '脚本',
    addFile: '添加文件',
    addFilePrompt: '它在技能内的路径。',
    addFilePlaceholder: 'reference/notes.md',
    remove: '移除',
    removeTitle: ({ path }) => `移除 ${path}？`,
    removeBody: '新会话获得的技能将不含它。',
    more: ({ count }) => `另外 ${count} 个`,
    binary: '不是文本文件',
    loading: '正在打开…',
    afterAdd: '技能进入你的资料库后，再添加更多文件。',
  },
  source: {
    title: '来源与更新',
    descriptionReview: '来源的更改会等你查看。',
    descriptionAuto: '来源的更改会自动到达，除非你改过它。',
    descriptionPinned: '已固定到某个版本。来源的更改会等到你取消固定。',
    descriptionOwn: '由你自己更改。除了你，没有谁会更新它。',
    writtenByYou: '由你编写',
    writtenByYouBody: '在这里编辑；每台机器都会收到更改。',
    uploadedByYou: '由你上传',
    foundOn: ({ machine }) => `在 ${machine} 上找到`,
    foundOnBody: ({ path }) => path,
    firstParty: '内置于 Happier · 跟随其版本',
    verifiedByDigest: '已通过摘要验证',
    noDigestPublished: '未发布摘要',
    added: ({ date }) => `添加于 ${date}`,
    updates: '更新',
    upToDate: '已是最新',
    updateAvailable: '有可用更新',
    removedFromSource: '来源中已没有它',
    notChecked: '尚未检查',
    checked: ({ time }) => `${time}检查`,
    checkNow: '立即检查',
    view: '查看',
    auto: '自动更新',
    autoBody: '他人的技能默认关闭，这样你会先看到每一处更改',
    pin: '固定到此版本',
    pinBody: '保留此版本，直到你取消固定',
    checkFailed: '无法检查来源',
  },
  machines: {
    description: '每台机器上的智能体当前获得的内容。',
    nowhere: '还没有在任何机器上开启。',
    offline: '机器离线',
    lastKnown: ({ time }) => `最后已知 ${time}`,
    masked: ({ agent, machine }) => `${agent}：${machine} 自己的副本优先`,
    cantLoad: ({ agents }) => `${agents} 无法在这里加载技能`,
    previewFailed: ({ agent }) => `${agent}：—`,
    checking: '正在检查…',
    projectNote: '在项目内，项目自己的副本仍可能优先。',
    noAgent: '这里没有智能体会获得它',
    offlineCount: ({ count }) => `${count} 台离线`,
    summaryOn: ({ agents, machine }) => `${machine} 上的 ${agents}`,
    summaryOnMany: ({ agents, count }) => `${count} 台设备上的 ${agents}`,
  },
  details: {
    title: '详情',
    summary: '修订版本和 Happier 之外的副本',
    revision: '修订版本',
    contentHash: '内容哈希',
    alsoInstall: ({ machine }) => `也安装到 ${machine}`,
    alsoInstallBody: '用于 Happier 之外，放入每个智能体自己的技能文件夹',
    installed: '已安装',
    install: '安装',
  },
  leave: {
    remove: '移除技能',
    footnote: '正在运行的会话会保留它，直到重新启动。',
    confirmTitle: ({ name }) => `移除 ${name}？`,
    confirmBody:
      '它会从你的资料库和每台机器上移除。正在运行的会话会保留它，直到重新启动。',
    confirm: '移除',
  },
  draft: {
    title: '新技能',
    purpose: '只需教你的智能体一次。它们会阅读描述来决定何时使用。',
    add: '添加到资料库',
    adding: '正在添加…',
    addFailed: '无法添加技能。你的文本已保留。',
  },
};

const zhHant: SkillDetailTranslation = {
  whereDescription: '設定一次，每台機器都會跟隨。最具體的規則優先。',
  tokensWhenUsed: ({ tokens }) => `使用時 ${tokens} 個 token`,
  menu: {
    duplicate: '複製',
    makeCopy: '建立可編輯的副本',
    moveToFolder: '移到資料夾',
    noFolder: '無資料夾',
    exportZip: '匯出為 .zip',
    copyLink: '複製連結',
    linkCopied: '已複製連結',
  },
  banner: {
    couldntLoadTitle: '無法載入此技能',
    couldntLoadBody: '你的資料庫沒有回應。工作階段會繼續使用已有的副本。',
  },
  instructions: {
    title: '指令',
    edit: '編輯',
    done: '完成',
    preview: '預覽',
    showAll: '顯示全部',
    showLess: '收合',
    saving: '正在儲存…',
    saved: '已儲存 · 適用於新的工作階段',
    saveFailed: '無法儲存。你的文字已保留。',
    conflict: '已在另一台裝置上變更',
    reviewBoth: '查看兩者',
    keepMine: '保留我的',
    takeTheirs: '採用對方的',
    yours: '你的',
    theirs: '對方的',
    lintOk: '名稱和說明已設定',
    lintMissingName: '在 frontmatter 中新增名稱',
    lintMissingDescription: '新增說明，讓代理知道何時使用',
    lintNoFrontmatter: '以 frontmatter 區塊開頭：名稱和說明',
    readOnlyPlugin: '隨其外掛提供，並跟隨外掛版本。',
  },
  files: {
    title: '檔案',
    description: ({ count }) =>
      count === 1 ? '1 個檔案，沒有指令碼。' : `${count} 個檔案，沒有指令碼。`,
    descriptionScripts: ({ count, scripts }) =>
      `${count} 個檔案，其中 ${scripts} 個會作為指令碼執行。`,
    script: '指令碼',
    addFile: '新增檔案',
    addFilePrompt: '它在技能內的路徑。',
    addFilePlaceholder: 'reference/notes.md',
    remove: '移除',
    removeTitle: ({ path }) => `移除 ${path}？`,
    removeBody: '新的工作階段取得的技能將不含它。',
    more: ({ count }) => `另外 ${count} 個`,
    binary: '不是文字檔',
    loading: '正在開啟…',
    afterAdd: '技能進入你的資料庫後，再新增更多檔案。',
  },
  source: {
    title: '來源與更新',
    descriptionReview: '來源的變更會等你查看。',
    descriptionAuto: '來源的變更會自動送達，除非你改過它。',
    descriptionPinned: '已固定在某個版本。來源的變更會等到你取消固定。',
    descriptionOwn: '由你自己變更。除了你，沒有誰會更新它。',
    writtenByYou: '由你撰寫',
    writtenByYouBody: '在這裡編輯；每台機器都會收到變更。',
    uploadedByYou: '由你上傳',
    foundOn: ({ machine }) => `在 ${machine} 上找到`,
    foundOnBody: ({ path }) => path,
    firstParty: '內建於 Happier · 跟隨其版本',
    verifiedByDigest: '已通過摘要驗證',
    noDigestPublished: '未發布摘要',
    added: ({ date }) => `新增於 ${date}`,
    updates: '更新',
    upToDate: '已是最新',
    updateAvailable: '有可用更新',
    removedFromSource: '來源中已沒有它',
    notChecked: '尚未檢查',
    checked: ({ time }) => `${time}檢查`,
    checkNow: '立即檢查',
    view: '查看',
    auto: '自動更新',
    autoBody: '他人的技能預設關閉，這樣你會先看到每一項變更',
    pin: '固定在此版本',
    pinBody: '保留此版本，直到你取消固定',
    checkFailed: '無法檢查來源',
  },
  machines: {
    description: '每台機器上的代理目前取得的內容。',
    nowhere: '還沒有在任何機器上開啟。',
    offline: '機器離線',
    lastKnown: ({ time }) => `最後已知 ${time}`,
    masked: ({ agent, machine }) => `${agent}：${machine} 自己的副本優先`,
    cantLoad: ({ agents }) => `${agents} 無法在這裡載入技能`,
    previewFailed: ({ agent }) => `${agent}：—`,
    checking: '正在檢查…',
    projectNote: '在專案內，專案自己的副本仍可能優先。',
    noAgent: '這裡沒有代理會取得它',
    offlineCount: ({ count }) => `${count} 台離線`,
    summaryOn: ({ agents, machine }) => `${machine} 上的 ${agents}`,
    summaryOnMany: ({ agents, count }) => `${count} 台裝置上的 ${agents}`,
  },
  details: {
    title: '詳細資料',
    summary: '修訂版本與 Happier 之外的副本',
    revision: '修訂版本',
    contentHash: '內容雜湊',
    alsoInstall: ({ machine }) => `也安裝到 ${machine}`,
    alsoInstallBody: '用於 Happier 之外，放入每個代理自己的技能資料夾',
    installed: '已安裝',
    install: '安裝',
  },
  leave: {
    remove: '移除技能',
    footnote: '執行中的工作階段會保留它，直到重新啟動。',
    confirmTitle: ({ name }) => `移除 ${name}？`,
    confirmBody:
      '它會從你的資料庫和每台機器上移除。執行中的工作階段會保留它，直到重新啟動。',
    confirm: '移除',
  },
  draft: {
    title: '新技能',
    purpose: '只要教你的代理一次。它們會閱讀說明來決定何時使用。',
    add: '新增到資料庫',
    adding: '正在新增…',
    addFailed: '無法新增技能。你的文字已保留。',
  },
};

export const skillDetailTranslations = {
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
  zhHans,
  zhHant,
} as const;
