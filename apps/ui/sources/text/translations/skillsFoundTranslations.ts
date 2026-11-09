// "Found on your machines" copy (P6 U6.5, sf F/Fp) and the opt-in "Also install on this machine" receipts
// on the skill detail. Mounted under `capabilities.skillsFound`.

export type SkillsFoundTranslation = Readonly<{
  title: string;
  purpose: string;
  checkAgain: string;
  add: string;
  addAll: (params: Readonly<{ count: number }>) => string;
  makeCopy: string;
  compare: string;
  hideCompare: string;
  inLibrary: string;
  adding: string;
  plugin: string;
  readBy: (params: Readonly<{ agents: string; count: number }>) => string;
  fromPlugin: (params: Readonly<{ plugin: string }>) => string;
  installedByHappier: string;
  masks: (params: Readonly<{ machine: string }>) => string;
  more: (params: Readonly<{ count: number }>) => string;
  showFewer: string;
  looking: string;
  nothingHere: string;
  quietEmpty: (params: Readonly<{ count: number; others: boolean }>) => string;
  quietLooking: (params: Readonly<{ count: number }>) => string;
  lastKnown: (params: Readonly<{ time: string }>) => string;
  offlineBring: (params: Readonly<{ machine: string }>) => string;
  offlineUnseen: (params: Readonly<{ count: number }>) => string;
  scanFailed: (params: Readonly<{ machine: string }>) => string;
  tryAgain: string;
  olderMachine: (params: Readonly<{ machine: string }>) => string;
  rootFailed: (params: Readonly<{ path: string }>) => string;
  noMachinesTitle: string;
  noMachinesBody: string;
  addFailed: (params: Readonly<{ name: string }>) => string;
  compareYours: string;
  compareTheirs: (params: Readonly<{ machine: string }>) => string;
  compareFailed: (params: Readonly<{ machine: string }>) => string;
  destination: string;
  homeBody: string;
  seeAll: (params: Readonly<{ count: number }>) => string;
  alreadyOnMachines: (params: Readonly<{ count: number }>) => string;
  install: Readonly<{
    installedIn: (params: Readonly<{ path: string }>) => string;
    externallyModified: (params: Readonly<{ machine: string }>) => string;
    removeAnyway: string;
    removeTitle: (params: Readonly<{ machine: string }>) => string;
    removeBody: string;
    remove: string;
    nativeConflict: (params: Readonly<{ machine: string }>) => string;
    failed: (params: Readonly<{ machine: string }>) => string;
    removeFailed: (params: Readonly<{ machine: string }>) => string;
    partial: (params: Readonly<{ machine: string }>) => string;
  }>;
}>;

export const en: SkillsFoundTranslation = {
  title: 'Found on your machines',
  purpose:
    'Skills your agents already keep on each machine. Happier never edits them. Add one to your library to have it on every machine.',
  checkAgain: 'Check again',
  add: 'Add to library',
  addAll: ({ count }) => `Add all ${count}`,
  makeCopy: 'Make a copy',
  compare: 'Compare',
  hideCompare: 'Hide',
  inLibrary: 'In your library',
  adding: 'Adding…',
  plugin: 'Plugin',
  readBy: ({ agents, count }) =>
    count === 1 ? `${agents} reads it` : `${agents} read it`,
  fromPlugin: ({ plugin }) => `From the ${plugin} plugin`,
  installedByHappier: 'Installed by Happier',
  masks: ({ machine }) =>
    `Your library has a skill with this name. On ${machine} this copy wins, so agents there use it instead.`,
  more: ({ count }) => `${count} more`,
  showFewer: 'Show fewer',
  looking: 'Looking…',
  nothingHere: 'No skills found here.',
  quietEmpty: ({ count, others }) =>
    `No skills found on ${count} ${others ? 'other ' : ''}${count === 1 ? 'machine' : 'machines'}`,
  quietLooking: ({ count }) =>
    `Looking on ${count} ${count === 1 ? 'machine' : 'machines'}…`,
  lastKnown: ({ time }) => `last known ${time}`,
  offlineBring: ({ machine }) => `Bring ${machine} online to add from it.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? `1 offline machine hasn't been looked at yet. Bring it online to see its skills.`
      : `${count} offline machines haven't been looked at yet. Bring one online to see its skills.`,
  scanFailed: ({ machine }) => `Couldn't read ${machine}'s skills`,
  tryAgain: 'Try again',
  olderMachine: ({ machine }) =>
    `${machine} needs a newer Happier to list its skills.`,
  rootFailed: ({ path }) => `Couldn't read ${path}`,
  noMachinesTitle: 'No machines yet',
  noMachinesBody:
    'Connect a machine to see the skills your agents already keep on it.',
  addFailed: ({ name }) => `Couldn't add ${name}. Nothing changed.`,
  compareYours: 'Your library',
  compareTheirs: ({ machine }) => `On ${machine}`,
  compareFailed: ({ machine }) => `Couldn't read the copy on ${machine}.`,
  destination: 'Found on your machines',
  homeBody:
    "Already in your agents' own folders. Add one to your library and it follows you everywhere.",
  seeAll: ({ count }) => `See all ${count}`,
  alreadyOnMachines: ({ count }) => `${count} skills are already on your machines`,
  install: {
    installedIn: ({ path }) => `Installed in ${path}`,
    externallyModified: ({ machine }) =>
      `The copy on ${machine} was edited outside Happier, so it was left as it is.`,
    removeAnyway: 'Remove anyway',
    removeTitle: ({ machine }) => `Remove from ${machine}?`,
    removeBody:
      'This deletes the copy Happier put in the agent folders there. Your library keeps the skill.',
    remove: 'Remove',
    nativeConflict: ({ machine }) =>
      `${machine} already has a different skill with this name in an agent folder. Happier left it alone.`,
    failed: ({ machine }) => `Couldn't install on ${machine}. Nothing changed.`,
    removeFailed: ({ machine }) => `Couldn't remove it from ${machine}.`,
    partial: ({ machine }) =>
      `Installed on ${machine} for some agents. Others couldn't be written.`,
  },
};

const ca: SkillsFoundTranslation = {
  title: 'Trobades a les teves màquines',
  purpose:
    'Habilitats que els teus agents ja tenen a cada màquina. Happier no les edita mai. Afegeix-ne una a la biblioteca per tenir-la a totes les màquines.',
  checkAgain: 'Torna a comprovar',
  add: 'Afegeix a la biblioteca',
  addAll: ({ count }) => `Afegeix-les totes (${count})`,
  makeCopy: 'Fes una còpia',
  compare: 'Compara',
  hideCompare: 'Amaga',
  inLibrary: 'A la teva biblioteca',
  adding: 'Afegint…',
  plugin: 'Connector',
  readBy: ({ agents, count }) =>
    count === 1 ? `${agents} la llegeix` : `${agents} la llegeixen`,
  fromPlugin: ({ plugin }) => `Del connector ${plugin}`,
  installedByHappier: 'Instal·lada per Happier',
  masks: ({ machine }) =>
    `La teva biblioteca té una habilitat amb aquest nom. A ${machine} preval aquesta còpia, així que els agents d’allà la fan servir.`,
  more: ({ count }) => `${count} més`,
  showFewer: 'Mostra’n menys',
  looking: 'Cercant…',
  nothingHere: 'No s’ha trobat cap habilitat aquí.',
  quietEmpty: ({ count, others }) =>
    `No s’ha trobat cap habilitat en ${count} ${count === 1 ? (others ? 'altra màquina' : 'màquina') : (others ? 'altres màquines' : 'màquines')}`,
  quietLooking: ({ count }) =>
    `Cercant en ${count} ${count === 1 ? 'màquina' : 'màquines'}…`,
  lastKnown: ({ time }) => `últim estat ${time}`,
  offlineBring: ({ machine }) =>
    `Posa ${machine} en línia per afegir-ne habilitats.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? `1 màquina fora de línia encara no s’ha consultat. Posa-la en línia per veure’n les habilitats.`
      : `${count} màquines fora de línia encara no s’han consultat. Posa’n una en línia per veure’n les habilitats.`,
  scanFailed: ({ machine }) =>
    `No s’han pogut llegir les habilitats de ${machine}`,
  tryAgain: 'Torna-ho a provar',
  olderMachine: ({ machine }) =>
    `${machine} necessita un Happier més nou per llistar-ne les habilitats.`,
  rootFailed: ({ path }) => `No s’ha pogut llegir ${path}`,
  noMachinesTitle: 'Encara no hi ha màquines',
  noMachinesBody:
    'Connecta una màquina per veure les habilitats que els teus agents ja hi tenen.',
  addFailed: ({ name }) => `No s’ha pogut afegir ${name}. No ha canviat res.`,
  compareYours: 'La teva biblioteca',
  compareTheirs: ({ machine }) => `A ${machine}`,
  compareFailed: ({ machine }) =>
    `No s’ha pogut llegir la còpia de ${machine}.`,
  destination: 'Trobades a les teves màquines',
  homeBody:
    'Ja són a les carpetes dels teus agents. Afegeix-ne una a la biblioteca i et seguirà a tot arreu.',
  seeAll: ({ count }) => `Mostra-les totes (${count})`,
  alreadyOnMachines: ({ count }) => `Ja hi ha ${count} habilitats a les teves màquines`,
  install: {
    installedIn: ({ path }) => `Instal·lada a ${path}`,
    externallyModified: ({ machine }) =>
      `La còpia de ${machine} s’ha editat fora de Happier, així que s’ha deixat tal com és.`,
    removeAnyway: 'Treu-la igualment',
    removeTitle: ({ machine }) => `Vols treure-la de ${machine}?`,
    removeBody:
      'Això elimina la còpia que Happier ha posat a les carpetes dels agents d’allà. La teva biblioteca conserva l’habilitat.',
    remove: 'Treu',
    nativeConflict: ({ machine }) =>
      `${machine} ja té una habilitat diferent amb aquest nom en una carpeta d’agent. Happier no l’ha tocada.`,
    failed: ({ machine }) =>
      `No s’ha pogut instal·lar a ${machine}. No ha canviat res.`,
    removeFailed: ({ machine }) => `No s’ha pogut treure de ${machine}.`,
    partial: ({ machine }) =>
      `Instal·lada a ${machine} per a alguns agents. No s’ha pogut escriure per als altres.`,
  },
};

const de: SkillsFoundTranslation = {
  title: 'Auf deinen Maschinen gefunden',
  purpose:
    'Skills, die deine Agenten schon auf jeder Maschine haben. Happier ändert sie nie. Füge einen zur Bibliothek hinzu, um ihn auf jeder Maschine zu haben.',
  checkAgain: 'Erneut prüfen',
  add: 'Zur Bibliothek hinzufügen',
  addAll: ({ count }) => `Alle ${count} hinzufügen`,
  makeCopy: 'Kopie erstellen',
  compare: 'Vergleichen',
  hideCompare: 'Ausblenden',
  inLibrary: 'In deiner Bibliothek',
  adding: 'Wird hinzugefügt…',
  plugin: 'Plugin',
  readBy: ({ agents, count }) =>
    count === 1 ? `${agents} liest ihn` : `${agents} lesen ihn`,
  fromPlugin: ({ plugin }) => `Aus dem Plugin ${plugin}`,
  installedByHappier: 'Von Happier installiert',
  masks: ({ machine }) =>
    `Deine Bibliothek hat einen Skill mit diesem Namen. Auf ${machine} gilt diese Kopie, deshalb nutzen die Agenten dort sie.`,
  more: ({ count }) => `${count} weitere`,
  showFewer: 'Weniger anzeigen',
  looking: 'Suche…',
  nothingHere: 'Hier wurden keine Skills gefunden.',
  quietEmpty: ({ count, others }) =>
    `Keine Skills auf ${count} ${others ? 'weiteren ' : ''}${count === 1 ? 'Maschine' : 'Maschinen'} gefunden`,
  quietLooking: ({ count }) =>
    `Suche auf ${count} ${count === 1 ? 'Maschine' : 'Maschinen'}…`,
  lastKnown: ({ time }) => `zuletzt bekannt ${time}`,
  offlineBring: ({ machine }) =>
    `Bring ${machine} online, um davon hinzuzufügen.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? `1 Offline-Maschine wurde noch nicht angesehen. Bring sie online, um ihre Skills zu sehen.`
      : `${count} Offline-Maschinen wurden noch nicht angesehen. Bring eine online, um ihre Skills zu sehen.`,
  scanFailed: ({ machine }) =>
    `Skills von ${machine} konnten nicht gelesen werden`,
  tryAgain: 'Erneut versuchen',
  olderMachine: ({ machine }) =>
    `${machine} braucht ein neueres Happier, um die Skills aufzulisten.`,
  rootFailed: ({ path }) => `${path} konnte nicht gelesen werden`,
  noMachinesTitle: 'Noch keine Maschinen',
  noMachinesBody:
    'Verbinde eine Maschine, um die Skills zu sehen, die deine Agenten dort schon haben.',
  addFailed: ({ name }) =>
    `${name} konnte nicht hinzugefügt werden. Es wurde nichts geändert.`,
  compareYours: 'Deine Bibliothek',
  compareTheirs: ({ machine }) => `Auf ${machine}`,
  compareFailed: ({ machine }) =>
    `Die Kopie auf ${machine} konnte nicht gelesen werden.`,
  destination: 'Auf deinen Maschinen gefunden',
  homeBody:
    'Schon in den eigenen Ordnern deiner Agenten. Füge einen zur Bibliothek hinzu, dann begleitet er dich überall.',
  seeAll: ({ count }) => `Alle ${count} ansehen`,
  alreadyOnMachines: ({ count }) => `${count} Skills sind schon auf deinen Maschinen`,
  install: {
    installedIn: ({ path }) => `Installiert in ${path}`,
    externallyModified: ({ machine }) =>
      `Die Kopie auf ${machine} wurde außerhalb von Happier bearbeitet und deshalb unverändert gelassen.`,
    removeAnyway: 'Trotzdem entfernen',
    removeTitle: ({ machine }) => `Von ${machine} entfernen?`,
    removeBody:
      'Das löscht die Kopie, die Happier dort in die Agent-Ordner gelegt hat. Deine Bibliothek behält den Skill.',
    remove: 'Entfernen',
    nativeConflict: ({ machine }) =>
      `${machine} hat in einem Agent-Ordner schon einen anderen Skill mit diesem Namen. Happier hat ihn unberührt gelassen.`,
    failed: ({ machine }) =>
      `Installation auf ${machine} fehlgeschlagen. Es wurde nichts geändert.`,
    removeFailed: ({ machine }) =>
      `Konnte nicht von ${machine} entfernt werden.`,
    partial: ({ machine }) =>
      `Auf ${machine} für einige Agenten installiert. Für die anderen konnte nicht geschrieben werden.`,
  },
};

const es: SkillsFoundTranslation = {
  title: 'Encontradas en tus máquinas',
  purpose:
    'Habilidades que tus agentes ya tienen en cada máquina. Happier nunca las edita. Añade una a tu biblioteca para tenerla en todas las máquinas.',
  checkAgain: 'Comprobar de nuevo',
  add: 'Añadir a la biblioteca',
  addAll: ({ count }) => `Añadir las ${count}`,
  makeCopy: 'Hacer una copia',
  compare: 'Comparar',
  hideCompare: 'Ocultar',
  inLibrary: 'En tu biblioteca',
  adding: 'Añadiendo…',
  plugin: 'Plugin',
  readBy: ({ agents, count }) =>
    count === 1 ? `${agents} la lee` : `${agents} la leen`,
  fromPlugin: ({ plugin }) => `Del plugin ${plugin}`,
  installedByHappier: 'Instalada por Happier',
  masks: ({ machine }) =>
    `Tu biblioteca tiene una habilidad con este nombre. En ${machine} gana esta copia, así que los agentes de allí usan esta.`,
  more: ({ count }) => `${count} más`,
  showFewer: 'Mostrar menos',
  looking: 'Buscando…',
  nothingHere: 'No se encontraron habilidades aquí.',
  quietEmpty: ({ count, others }) =>
    `No se encontraron habilidades en ${count} ${count === 1 ? (others ? 'máquina más' : 'máquina') : (others ? 'máquinas más' : 'máquinas')}`,
  quietLooking: ({ count }) =>
    `Buscando en ${count} ${count === 1 ? 'máquina' : 'máquinas'}…`,
  lastKnown: ({ time }) => `último estado ${time}`,
  offlineBring: ({ machine }) =>
    `Pon ${machine} en línea para añadir desde ella.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? `Aún no se ha revisado 1 máquina sin conexión. Ponla en línea para ver sus habilidades.`
      : `Aún no se han revisado ${count} máquinas sin conexión. Pon una en línea para ver sus habilidades.`,
  scanFailed: ({ machine }) =>
    `No se pudieron leer las habilidades de ${machine}`,
  tryAgain: 'Reintentar',
  olderMachine: ({ machine }) =>
    `${machine} necesita un Happier más reciente para listar sus habilidades.`,
  rootFailed: ({ path }) => `No se pudo leer ${path}`,
  noMachinesTitle: 'Aún no hay máquinas',
  noMachinesBody:
    'Conecta una máquina para ver las habilidades que tus agentes ya tienen en ella.',
  addFailed: ({ name }) => `No se pudo añadir ${name}. No cambió nada.`,
  compareYours: 'Tu biblioteca',
  compareTheirs: ({ machine }) => `En ${machine}`,
  compareFailed: ({ machine }) => `No se pudo leer la copia de ${machine}.`,
  destination: 'Encontradas en tus máquinas',
  homeBody:
    'Ya están en las carpetas de tus agentes. Añade una a tu biblioteca y te seguirá a todas partes.',
  seeAll: ({ count }) => `Ver las ${count}`,
  alreadyOnMachines: ({ count }) => `Ya hay ${count} habilidades en tus máquinas`,
  install: {
    installedIn: ({ path }) => `Instalada en ${path}`,
    externallyModified: ({ machine }) =>
      `La copia de ${machine} se editó fuera de Happier, así que se dejó como está.`,
    removeAnyway: 'Quitar de todos modos',
    removeTitle: ({ machine }) => `¿Quitar de ${machine}?`,
    removeBody:
      'Esto borra la copia que Happier puso en las carpetas de los agentes de allí. Tu biblioteca conserva la habilidad.',
    remove: 'Quitar',
    nativeConflict: ({ machine }) =>
      `${machine} ya tiene otra habilidad con este nombre en una carpeta de agente. Happier no la tocó.`,
    failed: ({ machine }) =>
      `No se pudo instalar en ${machine}. No cambió nada.`,
    removeFailed: ({ machine }) => `No se pudo quitar de ${machine}.`,
    partial: ({ machine }) =>
      `Instalada en ${machine} para algunos agentes. En los demás no se pudo escribir.`,
  },
};

const fr: SkillsFoundTranslation = {
  title: 'Trouvés sur vos machines',
  purpose:
    'Les skills que vos agents gardent déjà sur chaque machine. Happier ne les modifie jamais. Ajoutez-en un à votre bibliothèque pour l’avoir sur toutes vos machines.',
  checkAgain: 'Vérifier à nouveau',
  add: 'Ajouter à la bibliothèque',
  addAll: ({ count }) => `Tout ajouter (${count})`,
  makeCopy: 'Faire une copie',
  compare: 'Comparer',
  hideCompare: 'Masquer',
  inLibrary: 'Dans votre bibliothèque',
  adding: 'Ajout…',
  plugin: 'Plugin',
  readBy: ({ agents, count }) =>
    count === 1 ? `${agents} le lit` : `${agents} le lisent`,
  fromPlugin: ({ plugin }) => `Du plugin ${plugin}`,
  installedByHappier: 'Installé par Happier',
  masks: ({ machine }) =>
    `Votre bibliothèque contient un skill portant ce nom. Sur ${machine}, cette copie l’emporte : les agents de cette machine l’utilisent.`,
  more: ({ count }) => `${count} de plus`,
  showFewer: 'Afficher moins',
  looking: 'Recherche…',
  nothingHere: 'Aucun skill trouvé ici.',
  quietEmpty: ({ count, others }) =>
    `Aucun skill trouvé sur ${count} ${others ? (count === 1 ? 'autre ' : 'autres ') : ''}${count === 1 ? 'machine' : 'machines'}`,
  quietLooking: ({ count }) =>
    `Recherche sur ${count} ${count === 1 ? 'machine' : 'machines'}…`,
  lastKnown: ({ time }) => `dernier état ${time}`,
  offlineBring: ({ machine }) =>
    `Mettez ${machine} en ligne pour ajouter depuis cette machine.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? `1 machine hors ligne n’a pas encore été consultée. Mettez-la en ligne pour voir ses skills.`
      : `${count} machines hors ligne n’ont pas encore été consultées. Mettez-en une en ligne pour voir ses skills.`,
  scanFailed: ({ machine }) => `Impossible de lire les skills de ${machine}`,
  tryAgain: 'Réessayer',
  olderMachine: ({ machine }) =>
    `${machine} a besoin d’un Happier plus récent pour lister ses skills.`,
  rootFailed: ({ path }) => `Impossible de lire ${path}`,
  noMachinesTitle: 'Aucune machine pour l’instant',
  noMachinesBody:
    'Connectez une machine pour voir les skills que vos agents y gardent déjà.',
  addFailed: ({ name }) => `Impossible d’ajouter ${name}. Rien n’a changé.`,
  compareYours: 'Votre bibliothèque',
  compareTheirs: ({ machine }) => `Sur ${machine}`,
  compareFailed: ({ machine }) =>
    `Impossible de lire la copie sur ${machine}.`,
  destination: 'Trouvés sur vos machines',
  homeBody:
    'Déjà dans les dossiers de vos agents. Ajoutez-en un à votre bibliothèque et il vous suit partout.',
  seeAll: ({ count }) => `Tout voir (${count})`,
  alreadyOnMachines: ({ count }) => `${count} compétences sont déjà sur vos machines`,
  install: {
    installedIn: ({ path }) => `Installé dans ${path}`,
    externallyModified: ({ machine }) =>
      `La copie sur ${machine} a été modifiée en dehors de Happier, elle a donc été laissée telle quelle.`,
    removeAnyway: 'Retirer quand même',
    removeTitle: ({ machine }) => `Retirer de ${machine} ?`,
    removeBody:
      'Cela supprime la copie que Happier a placée dans les dossiers des agents de cette machine. Votre bibliothèque garde le skill.',
    remove: 'Retirer',
    nativeConflict: ({ machine }) =>
      `${machine} a déjà un autre skill portant ce nom dans un dossier d’agent. Happier n’y a pas touché.`,
    failed: ({ machine }) =>
      `Impossible d’installer sur ${machine}. Rien n’a changé.`,
    removeFailed: ({ machine }) => `Impossible de le retirer de ${machine}.`,
    partial: ({ machine }) =>
      `Installé sur ${machine} pour certains agents. Les autres n’ont pas pu être écrits.`,
  },
};

const it: SkillsFoundTranslation = {
  title: 'Trovate sulle tue macchine',
  purpose:
    'Le skill che i tuoi agenti hanno già su ogni macchina. Happier non le modifica mai. Aggiungine una alla libreria per averla su tutte le macchine.',
  checkAgain: 'Controlla di nuovo',
  add: 'Aggiungi alla libreria',
  addAll: ({ count }) => `Aggiungi tutte (${count})`,
  makeCopy: 'Crea una copia',
  compare: 'Confronta',
  hideCompare: 'Nascondi',
  inLibrary: 'Nella tua libreria',
  adding: 'Aggiunta…',
  plugin: 'Plugin',
  readBy: ({ agents, count }) =>
    count === 1 ? `${agents} la legge` : `${agents} la leggono`,
  fromPlugin: ({ plugin }) => `Dal plugin ${plugin}`,
  installedByHappier: 'Installata da Happier',
  masks: ({ machine }) =>
    `La tua libreria ha una skill con questo nome. Su ${machine} prevale questa copia, quindi gli agenti lì usano questa.`,
  more: ({ count }) => `Altri ${count}`,
  showFewer: 'Mostra meno',
  looking: 'Ricerca…',
  nothingHere: 'Nessuna skill trovata qui.',
  quietEmpty: ({ count, others }) =>
    `Nessuna skill trovata su ${count} ${count === 1 ? (others ? 'altra macchina' : 'macchina') : (others ? 'altre macchine' : 'macchine')}`,
  quietLooking: ({ count }) =>
    `Ricerca su ${count} ${count === 1 ? 'macchina' : 'macchine'}…`,
  lastKnown: ({ time }) => `ultimo stato ${time}`,
  offlineBring: ({ machine }) =>
    `Porta online ${machine} per aggiungere da lì.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? `1 macchina offline non è ancora stata controllata. Portala online per vederne le skill.`
      : `${count} macchine offline non sono ancora state controllate. Portane una online per vederne le skill.`,
  scanFailed: ({ machine }) => `Impossibile leggere le skill di ${machine}`,
  tryAgain: 'Riprova',
  olderMachine: ({ machine }) =>
    `${machine} richiede una versione più recente di Happier per elencare le sue skill.`,
  rootFailed: ({ path }) => `Impossibile leggere ${path}`,
  noMachinesTitle: 'Ancora nessuna macchina',
  noMachinesBody:
    'Collega una macchina per vedere le skill che i tuoi agenti hanno già.',
  addFailed: ({ name }) =>
    `Impossibile aggiungere ${name}. Non è cambiato nulla.`,
  compareYours: 'La tua libreria',
  compareTheirs: ({ machine }) => `Su ${machine}`,
  compareFailed: ({ machine }) =>
    `Impossibile leggere la copia su ${machine}.`,
  destination: 'Trovate sulle tue macchine',
  homeBody:
    'Già nelle cartelle dei tuoi agenti. Aggiungine una alla libreria e ti segue ovunque.',
  seeAll: ({ count }) => `Vedi tutte (${count})`,
  alreadyOnMachines: ({ count }) => `Ci sono già ${count} skill sulle tue macchine`,
  install: {
    installedIn: ({ path }) => `Installata in ${path}`,
    externallyModified: ({ machine }) =>
      `La copia su ${machine} è stata modificata fuori da Happier, quindi è stata lasciata com’è.`,
    removeAnyway: 'Rimuovi comunque',
    removeTitle: ({ machine }) => `Rimuovere da ${machine}?`,
    removeBody:
      'Questo elimina la copia che Happier ha messo nelle cartelle degli agenti lì. La tua libreria conserva la skill.',
    remove: 'Rimuovi',
    nativeConflict: ({ machine }) =>
      `${machine} ha già una skill diversa con questo nome in una cartella di un agente. Happier non l’ha toccata.`,
    failed: ({ machine }) =>
      `Impossibile installare su ${machine}. Non è cambiato nulla.`,
    removeFailed: ({ machine }) => `Impossibile rimuoverla da ${machine}.`,
    partial: ({ machine }) =>
      `Installata su ${machine} per alcuni agenti. Per gli altri non è stato possibile scrivere.`,
  },
};

const ja: SkillsFoundTranslation = {
  title: 'マシンで見つかったスキル',
  purpose:
    'エージェントが各マシンにすでに持っているスキルです。Happier が編集することはありません。ライブラリに追加すると、すべてのマシンで使えます。',
  checkAgain: 'もう一度確認',
  add: 'ライブラリに追加',
  addAll: ({ count }) => `${count} 件すべてを追加`,
  makeCopy: 'コピーを作成',
  compare: '比較',
  hideCompare: '閉じる',
  inLibrary: 'ライブラリにあります',
  adding: '追加中…',
  plugin: 'プラグイン',
  readBy: ({ agents }) => `${agents}が読み込みます`,
  fromPlugin: ({ plugin }) => `${plugin} プラグインから`,
  installedByHappier: 'Happier がインストール',
  masks: ({ machine }) =>
    `ライブラリに同じ名前のスキルがあります。${machine} ではこのコピーが優先され、そこのエージェントはこちらを使います。`,
  more: ({ count }) => `ほか ${count} 件`,
  showFewer: '表示を減らす',
  looking: '探しています…',
  nothingHere: 'ここにはスキルが見つかりません。',
  quietEmpty: ({ count, others }) =>
    others ? `他の ${count} 台のマシンにはスキルが見つかりません` : `${count} 台のマシンにはスキルが見つかりません`,
  quietLooking: ({ count }) =>
    `${count} 台のマシンを探しています…`,
  lastKnown: ({ time }) => `最終確認 ${time}`,
  offlineBring: ({ machine }) =>
    `${machine} をオンラインにすると、そこから追加できます。`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? `オフラインのマシン 1 台はまだ確認していません。オンラインにするとスキルを表示できます。`
      : `オフラインのマシン ${count} 台はまだ確認していません。オンラインにするとスキルを表示できます。`,
  scanFailed: ({ machine }) => `${machine} のスキルを読み取れませんでした`,
  tryAgain: 'もう一度試す',
  olderMachine: ({ machine }) =>
    `${machine} のスキルを一覧表示するには、より新しい Happier が必要です。`,
  rootFailed: ({ path }) => `${path} を読み取れませんでした`,
  noMachinesTitle: 'マシンはまだありません',
  noMachinesBody:
    'マシンを接続すると、エージェントがそこにすでに持っているスキルが表示されます。',
  addFailed: ({ name }) =>
    `${name} を追加できませんでした。何も変更されていません。`,
  compareYours: 'ライブラリ',
  compareTheirs: ({ machine }) => `${machine} 上`,
  compareFailed: ({ machine }) =>
    `${machine} のコピーを読み取れませんでした。`,
  destination: 'マシンで見つかったスキル',
  homeBody:
    'エージェント自身のフォルダーにすでにあります。ライブラリに追加すると、どこでも使えます。',
  seeAll: ({ count }) => `${count} 件すべて表示`,
  alreadyOnMachines: ({ count }) => `${count} 件のスキルがすでにマシンにあります`,
  install: {
    installedIn: ({ path }) => `${path} にインストール済み`,
    externallyModified: ({ machine }) =>
      `${machine} のコピーは Happier の外で編集されたため、そのままにしました。`,
    removeAnyway: 'それでも削除',
    removeTitle: ({ machine }) => `${machine} から削除しますか？`,
    removeBody:
      'Happier がそこのエージェントのフォルダに置いたコピーを削除します。ライブラリのスキルは残ります。',
    remove: '削除',
    nativeConflict: ({ machine }) =>
      `${machine} のエージェントのフォルダに、同じ名前の別のスキルがすでにあります。Happier はそのままにしました。`,
    failed: ({ machine }) =>
      `${machine} にインストールできませんでした。何も変更されていません。`,
    removeFailed: ({ machine }) => `${machine} から削除できませんでした。`,
    partial: ({ machine }) =>
      `${machine} の一部のエージェントにインストールしました。そのほかには書き込めませんでした。`,
  },
};

const pl: SkillsFoundTranslation = {
  title: 'Znalezione na Twoich maszynach',
  purpose:
    'Umiejętności, które Twoi agenci już mają na każdej maszynie. Happier nigdy ich nie edytuje. Dodaj jedną do biblioteki, aby mieć ją na każdej maszynie.',
  checkAgain: 'Sprawdź ponownie',
  add: 'Dodaj do biblioteki',
  addAll: ({ count }) => `Dodaj wszystkie (${count})`,
  makeCopy: 'Utwórz kopię',
  compare: 'Porównaj',
  hideCompare: 'Ukryj',
  inLibrary: 'W Twojej bibliotece',
  adding: 'Dodawanie…',
  plugin: 'Wtyczka',
  readBy: ({ agents, count }) =>
    count === 1 ? `${agents} czyta ją` : `${agents} czytają ją`,
  fromPlugin: ({ plugin }) => `Z wtyczki ${plugin}`,
  installedByHappier: 'Zainstalowana przez Happier',
  masks: ({ machine }) =>
    `Twoja biblioteka ma umiejętność o tej nazwie. Na ${machine} ta kopia ma pierwszeństwo, więc agenci tam używają jej.`,
  more: ({ count }) => `Jeszcze ${count}`,
  showFewer: 'Pokaż mniej',
  looking: 'Szukanie…',
  nothingHere: 'Nie znaleziono tu umiejętności.',
  quietEmpty: ({ count, others }) =>
    others ? `Pozostałe maszyny bez znalezionych umiejętności: ${count}` : `Maszyny bez znalezionych umiejętności: ${count}`,
  quietLooking: ({ count }) =>
    `Szukanie na maszynach: ${count}…`,
  lastKnown: ({ time }) => `ostatni stan ${time}`,
  offlineBring: ({ machine }) =>
    `Włącz ${machine} online, aby dodać z niej umiejętności.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? `1 maszyna offline nie została jeszcze sprawdzona. Włącz ją online, aby zobaczyć jej umiejętności.`
      : `Maszyny offline, które nie zostały jeszcze sprawdzone: ${count}. Włącz jedną online, aby zobaczyć jej umiejętności.`,
  scanFailed: ({ machine }) =>
    `Nie udało się odczytać umiejętności z ${machine}`,
  tryAgain: 'Spróbuj ponownie',
  olderMachine: ({ machine }) =>
    `${machine} wymaga nowszej wersji Happier, aby wyświetlić swoje umiejętności.`,
  rootFailed: ({ path }) => `Nie udało się odczytać ${path}`,
  noMachinesTitle: 'Brak maszyn',
  noMachinesBody:
    'Połącz maszynę, aby zobaczyć umiejętności, które Twoi agenci już na niej mają.',
  addFailed: ({ name }) => `Nie udało się dodać ${name}. Nic się nie zmieniło.`,
  compareYours: 'Twoja biblioteka',
  compareTheirs: ({ machine }) => `Na ${machine}`,
  compareFailed: ({ machine }) =>
    `Nie udało się odczytać kopii z ${machine}.`,
  destination: 'Znalezione na Twoich maszynach',
  homeBody:
    'Już w folderach Twoich agentów. Dodaj jedną do biblioteki, a będzie z Tobą wszędzie.',
  seeAll: ({ count }) => `Zobacz wszystkie (${count})`,
  alreadyOnMachines: ({ count }) => `Na Twoich maszynach jest już ${count} umiejętności`,
  install: {
    installedIn: ({ path }) => `Zainstalowano w ${path}`,
    externallyModified: ({ machine }) =>
      `Kopia na ${machine} została zmieniona poza Happier, więc została bez zmian.`,
    removeAnyway: 'Usuń mimo to',
    removeTitle: ({ machine }) => `Usunąć z ${machine}?`,
    removeBody:
      'To usuwa kopię, którą Happier umieścił w folderach agentów na tej maszynie. Twoja biblioteka zachowuje umiejętność.',
    remove: 'Usuń',
    nativeConflict: ({ machine }) =>
      `${machine} ma już inną umiejętność o tej nazwie w folderze agenta. Happier jej nie ruszył.`,
    failed: ({ machine }) =>
      `Nie udało się zainstalować na ${machine}. Nic się nie zmieniło.`,
    removeFailed: ({ machine }) => `Nie udało się usunąć z ${machine}.`,
    partial: ({ machine }) =>
      `Zainstalowano na ${machine} dla niektórych agentów. Pozostałych nie udało się zapisać.`,
  },
};

const pt: SkillsFoundTranslation = {
  title: 'Encontradas nas suas máquinas',
  purpose:
    'Habilidades que os seus agentes já têm em cada máquina. O Happier nunca as edita. Adicione uma à biblioteca para a ter em todas as máquinas.',
  checkAgain: 'Verificar novamente',
  add: 'Adicionar à biblioteca',
  addAll: ({ count }) => `Adicionar todas (${count})`,
  makeCopy: 'Fazer uma cópia',
  compare: 'Comparar',
  hideCompare: 'Ocultar',
  inLibrary: 'Na sua biblioteca',
  adding: 'A adicionar…',
  plugin: 'Plug-in',
  readBy: ({ agents, count }) =>
    count === 1 ? `${agents} lê-a` : `${agents} leem-na`,
  fromPlugin: ({ plugin }) => `Do plug-in ${plugin}`,
  installedByHappier: 'Instalada pelo Happier',
  masks: ({ machine }) =>
    `A sua biblioteca tem uma habilidade com este nome. Em ${machine}, esta cópia prevalece, por isso os agentes de lá usam-na.`,
  more: ({ count }) => `Mais ${count}`,
  showFewer: 'Mostrar menos',
  looking: 'A procurar…',
  nothingHere: 'Nenhuma habilidade encontrada aqui.',
  quietEmpty: ({ count, others }) =>
    `Nenhuma habilidade encontrada em ${count} ${count === 1 ? (others ? 'outra máquina' : 'máquina') : (others ? 'outras máquinas' : 'máquinas')}`,
  quietLooking: ({ count }) =>
    `A procurar em ${count} ${count === 1 ? 'máquina' : 'máquinas'}…`,
  lastKnown: ({ time }) => `último estado ${time}`,
  offlineBring: ({ machine }) =>
    `Coloque ${machine} online para adicionar a partir dela.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? `1 máquina offline ainda não foi verificada. Coloque-a online para ver as suas habilidades.`
      : `${count} máquinas offline ainda não foram verificadas. Coloque uma online para ver as suas habilidades.`,
  scanFailed: ({ machine }) =>
    `Não foi possível ler as habilidades de ${machine}`,
  tryAgain: 'Tentar novamente',
  olderMachine: ({ machine }) =>
    `${machine} precisa de um Happier mais recente para listar as suas habilidades.`,
  rootFailed: ({ path }) => `Não foi possível ler ${path}`,
  noMachinesTitle: 'Ainda sem máquinas',
  noMachinesBody:
    'Ligue uma máquina para ver as habilidades que os seus agentes já têm nela.',
  addFailed: ({ name }) =>
    `Não foi possível adicionar ${name}. Nada foi alterado.`,
  compareYours: 'A sua biblioteca',
  compareTheirs: ({ machine }) => `Em ${machine}`,
  compareFailed: ({ machine }) =>
    `Não foi possível ler a cópia em ${machine}.`,
  destination: 'Encontradas nas suas máquinas',
  homeBody:
    'Já estão nas pastas dos seus agentes. Adicione uma à biblioteca e ela acompanha você em todo lugar.',
  seeAll: ({ count }) => `Ver todas (${count})`,
  alreadyOnMachines: ({ count }) => `Já existem ${count} habilidades nas suas máquinas`,
  install: {
    installedIn: ({ path }) => `Instalada em ${path}`,
    externallyModified: ({ machine }) =>
      `A cópia em ${machine} foi editada fora do Happier, por isso foi deixada como está.`,
    removeAnyway: 'Remover mesmo assim',
    removeTitle: ({ machine }) => `Remover de ${machine}?`,
    removeBody:
      'Isto apaga a cópia que o Happier colocou nas pastas dos agentes de lá. A sua biblioteca mantém a habilidade.',
    remove: 'Remover',
    nativeConflict: ({ machine }) =>
      `${machine} já tem uma habilidade diferente com este nome numa pasta de agente. O Happier não lhe tocou.`,
    failed: ({ machine }) =>
      `Não foi possível instalar em ${machine}. Nada foi alterado.`,
    removeFailed: ({ machine }) => `Não foi possível remover de ${machine}.`,
    partial: ({ machine }) =>
      `Instalada em ${machine} para alguns agentes. Não foi possível escrever nos outros.`,
  },
};

const ru: SkillsFoundTranslation = {
  title: 'Найдено на ваших машинах',
  purpose:
    'Скиллы, которые агенты уже хранят на каждой машине. Happier никогда их не изменяет. Добавьте скилл в библиотеку, чтобы он был на всех машинах.',
  checkAgain: 'Проверить снова',
  add: 'Добавить в библиотеку',
  addAll: ({ count }) => `Добавить все (${count})`,
  makeCopy: 'Сделать копию',
  compare: 'Сравнить',
  hideCompare: 'Скрыть',
  inLibrary: 'В вашей библиотеке',
  adding: 'Добавление…',
  plugin: 'Плагин',
  readBy: ({ agents, count }) =>
    count === 1 ? `${agents} читает его` : `${agents} читают его`,
  fromPlugin: ({ plugin }) => `Из плагина ${plugin}`,
  installedByHappier: 'Установлен Happier',
  masks: ({ machine }) =>
    `В вашей библиотеке есть скилл с таким именем. На ${machine} приоритет у этой копии, поэтому агенты там используют её.`,
  more: ({ count }) => `Ещё ${count}`,
  showFewer: 'Показать меньше',
  looking: 'Поиск…',
  nothingHere: 'Скиллы здесь не найдены.',
  quietEmpty: ({ count, others }) =>
    others ? `Скиллы не найдены на других машинах: ${count}` : `Скиллы не найдены на машинах: ${count}`,
  quietLooking: ({ count }) =>
    `Поиск на машинах: ${count}…`,
  lastKnown: ({ time }) => `последнее состояние ${time}`,
  offlineBring: ({ machine }) =>
    `Подключите ${machine} к сети, чтобы добавлять скиллы с неё.`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? `Одна машина не в сети ещё не просмотрена. Подключите её, чтобы увидеть её скиллы.`
      : `Машины не в сети, которые ещё не просмотрены: ${count}. Подключите одну из них, чтобы увидеть её скиллы.`,
  scanFailed: ({ machine }) => `Не удалось прочитать скиллы машины ${machine}`,
  tryAgain: 'Повторить',
  olderMachine: ({ machine }) =>
    `Чтобы показать скиллы, ${machine} нужна более новая версия Happier.`,
  rootFailed: ({ path }) => `Не удалось прочитать ${path}`,
  noMachinesTitle: 'Машин пока нет',
  noMachinesBody:
    'Подключите машину, чтобы увидеть скиллы, которые агенты уже хранят на ней.',
  addFailed: ({ name }) =>
    `Не удалось добавить ${name}. Ничего не изменилось.`,
  compareYours: 'Ваша библиотека',
  compareTheirs: ({ machine }) => `На ${machine}`,
  compareFailed: ({ machine }) =>
    `Не удалось прочитать копию на ${machine}.`,
  destination: 'Найдено на ваших машинах',
  homeBody:
    'Уже лежат в папках ваших агентов. Добавьте навык в библиотеку, и он будет с вами везде.',
  seeAll: ({ count }) => `Все (${count})`,
  alreadyOnMachines: ({ count }) => `На ваших машинах уже есть навыков: ${count}`,
  install: {
    installedIn: ({ path }) => `Установлен в ${path}`,
    externallyModified: ({ machine }) =>
      `Копия на ${machine} была изменена вне Happier, поэтому осталась как есть.`,
    removeAnyway: 'Всё равно удалить',
    removeTitle: ({ machine }) => `Удалить с ${machine}?`,
    removeBody:
      'Это удалит копию, которую Happier поместил в папки агентов на этой машине. Скилл останется в вашей библиотеке.',
    remove: 'Удалить',
    nativeConflict: ({ machine }) =>
      `На ${machine} в папке агента уже есть другой скилл с таким именем. Happier его не тронул.`,
    failed: ({ machine }) =>
      `Не удалось установить на ${machine}. Ничего не изменилось.`,
    removeFailed: ({ machine }) => `Не удалось удалить с ${machine}.`,
    partial: ({ machine }) =>
      `Установлено на ${machine} для некоторых агентов. Для остальных записать не удалось.`,
  },
};

const zhHans: SkillsFoundTranslation = {
  title: '在你的机器上找到',
  purpose:
    '你的智能体已经保存在每台机器上的技能。Happier 不会编辑它们。将其添加到资料库，即可在每台机器上使用。',
  checkAgain: '重新检查',
  add: '添加到资料库',
  addAll: ({ count }) => `全部添加（${count}）`,
  makeCopy: '创建副本',
  compare: '比较',
  hideCompare: '隐藏',
  inLibrary: '已在你的资料库中',
  adding: '正在添加…',
  plugin: '插件',
  readBy: ({ agents }) => `${agents} 会读取它`,
  fromPlugin: ({ plugin }) => `来自插件 ${plugin}`,
  installedByHappier: '由 Happier 安装',
  masks: ({ machine }) =>
    `你的资料库中有同名技能。在 ${machine} 上，这个副本优先，因此那里的智能体会使用它。`,
  more: ({ count }) => `另外 ${count} 个`,
  showFewer: '显示更少',
  looking: '正在查找…',
  nothingHere: '这里没有找到技能。',
  quietEmpty: ({ count, others }) =>
    others ? `另外 ${count} 台机器上没有找到技能` : `${count} 台机器上没有找到技能`,
  quietLooking: ({ count }) =>
    `正在 ${count} 台机器上查找…`,
  lastKnown: ({ time }) => `最后已知 ${time}`,
  offlineBring: ({ machine }) => `让 ${machine} 上线后，才能从中添加。`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? `有 1 台离线机器尚未查看。让它上线即可查看其技能。`
      : `有 ${count} 台离线机器尚未查看。让其中一台上线即可查看其技能。`,
  scanFailed: ({ machine }) => `无法读取 ${machine} 的技能`,
  tryAgain: '重试',
  olderMachine: ({ machine }) =>
    `${machine} 需要更新版本的 Happier 才能列出其技能。`,
  rootFailed: ({ path }) => `无法读取 ${path}`,
  noMachinesTitle: '还没有机器',
  noMachinesBody: '连接一台机器，即可查看你的智能体已保存在其上的技能。',
  addFailed: ({ name }) => `无法添加 ${name}。未作任何更改。`,
  compareYours: '你的资料库',
  compareTheirs: ({ machine }) => `在 ${machine} 上`,
  compareFailed: ({ machine }) => `无法读取 ${machine} 上的副本。`,
  destination: '在你的机器上找到',
  homeBody:
    '已在你的智能体自己的文件夹中。加入资料库后，它会随你到每台机器。',
  seeAll: ({ count }) => `查看全部 ${count} 个`,
  alreadyOnMachines: ({ count }) => `你的机器上已有 ${count} 个技能`,
  install: {
    installedIn: ({ path }) => `已安装在 ${path}`,
    externallyModified: ({ machine }) =>
      `${machine} 上的副本在 Happier 之外被编辑过，因此保持原样。`,
    removeAnyway: '仍然移除',
    removeTitle: ({ machine }) => `从 ${machine} 移除？`,
    removeBody:
      '这会删除 Happier 放在那里智能体文件夹中的副本。你的资料库会保留该技能。',
    remove: '移除',
    nativeConflict: ({ machine }) =>
      `${machine} 的某个智能体文件夹中已有同名的不同技能。Happier 没有改动它。`,
    failed: ({ machine }) => `无法安装到 ${machine}。未作任何更改。`,
    removeFailed: ({ machine }) => `无法从 ${machine} 移除。`,
    partial: ({ machine }) =>
      `已为部分智能体安装到 ${machine}。其他的无法写入。`,
  },
};

const zhHant: SkillsFoundTranslation = {
  title: '在你的機器上找到',
  purpose:
    '你的代理已經存放在每台機器上的技能。Happier 不會編輯它們。將其新增到資料庫，即可在每台機器上使用。',
  checkAgain: '重新檢查',
  add: '新增到資料庫',
  addAll: ({ count }) => `全部新增（${count}）`,
  makeCopy: '建立副本',
  compare: '比較',
  hideCompare: '隱藏',
  inLibrary: '已在你的資料庫中',
  adding: '正在新增…',
  plugin: '外掛',
  readBy: ({ agents }) => `${agents} 會讀取它`,
  fromPlugin: ({ plugin }) => `來自外掛 ${plugin}`,
  installedByHappier: '由 Happier 安裝',
  masks: ({ machine }) =>
    `你的資料庫中有同名技能。在 ${machine} 上，這個副本優先，因此那裡的代理會使用它。`,
  more: ({ count }) => `另外 ${count} 個`,
  showFewer: '顯示較少',
  looking: '正在尋找…',
  nothingHere: '這裡沒有找到技能。',
  quietEmpty: ({ count, others }) =>
    others ? `另外 ${count} 台機器上沒有找到技能` : `${count} 台機器上沒有找到技能`,
  quietLooking: ({ count }) =>
    `正在 ${count} 台機器上尋找…`,
  lastKnown: ({ time }) => `最後已知 ${time}`,
  offlineBring: ({ machine }) => `讓 ${machine} 上線後，才能從中新增。`,
  offlineUnseen: ({ count }) =>
    count === 1
      ? `有 1 台離線機器尚未查看。讓它上線即可查看其技能。`
      : `有 ${count} 台離線機器尚未查看。讓其中一台上線即可查看其技能。`,
  scanFailed: ({ machine }) => `無法讀取 ${machine} 的技能`,
  tryAgain: '重試',
  olderMachine: ({ machine }) =>
    `${machine} 需要較新版本的 Happier 才能列出其技能。`,
  rootFailed: ({ path }) => `無法讀取 ${path}`,
  noMachinesTitle: '還沒有機器',
  noMachinesBody: '連接一台機器，即可查看你的代理已存放在其上的技能。',
  addFailed: ({ name }) => `無法新增 ${name}。未作任何變更。`,
  compareYours: '你的資料庫',
  compareTheirs: ({ machine }) => `在 ${machine} 上`,
  compareFailed: ({ machine }) => `無法讀取 ${machine} 上的副本。`,
  destination: '在你的機器上找到',
  homeBody:
    '已在你的代理自己的資料夾中。加入資料庫後，它會隨你到每台機器。',
  seeAll: ({ count }) => `查看全部 ${count} 個`,
  alreadyOnMachines: ({ count }) => `你的機器上已有 ${count} 個技能`,
  install: {
    installedIn: ({ path }) => `已安裝在 ${path}`,
    externallyModified: ({ machine }) =>
      `${machine} 上的副本在 Happier 之外被編輯過，因此保持原樣。`,
    removeAnyway: '仍然移除',
    removeTitle: ({ machine }) => `從 ${machine} 移除？`,
    removeBody:
      '這會刪除 Happier 放在那裡代理資料夾中的副本。你的資料庫會保留該技能。',
    remove: '移除',
    nativeConflict: ({ machine }) =>
      `${machine} 的某個代理資料夾中已有同名的不同技能。Happier 沒有更動它。`,
    failed: ({ machine }) => `無法安裝到 ${machine}。未作任何變更。`,
    removeFailed: ({ machine }) => `無法從 ${machine} 移除。`,
    partial: ({ machine }) =>
      `已為部分代理安裝到 ${machine}。其他的無法寫入。`,
  },
};

export const skillsFoundTranslations = {
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
