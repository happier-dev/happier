type Name = Readonly<{ name: string }>;

type Copy = Readonly<{
  menuTitle: string;
  menuSubtitle: string;
  title: string;
  steps: Readonly<{ start: string; describe: string; create: string }>;
  startTitle: string;
  startDescription: string;
  startNewDescription: string;
  yourCode: string;
  startNew: string;
  otherProject: string;
  codeSubtitle: (p: Readonly<{ repository: string; provider: string }>) => string;
  startPick: string;
  haveCode: string;
  alreadyBuilt: string;
  builtImage: string;
  builtImageSubtitle: string;
  builtCompose: string;
  builtComposeSubtitle: string;
  browseCatalog: string;
  fromCatalog: string;
  addFolder: string;
  clone: string;
  describeTitle: string;
  describeDescription: string;
  describePlaceholder: string;
  describeLabel: string;
  name: string;
  namePlaceholder: string;
  codeLivesIn: string;
  privateRepository: string;
  builtBy: string;
  on: string;
  noComputer: string;
  connectGithub: string;
  githubNeeded: string;
  computerNeeded: string;
  machineHomeMismatch: string;
  addComputer: string;
  details: string;
  detailStarter: string;
  detailBuiltWith: string;
  detailRevision: string;
  detailBranch: string;
  detailAction: string;
  reviewNote: string;
  create: string;
  creatingTitle: (p: Name) => string;
  creatingDescription: string;
  failedTitle: string;
  failedKept: string;
  failedNothing: string;
  retry: string;
  keepsGoing: string;
  stepRepository: string;
  stepStarter: (p: Name) => string;
  stepCheckout: (p: Name) => string;
  stepAgent: string;
  stepAgentWaits: string;
  outcomeUnknown: string;
  checkRepository: string;
  readyTitle: string;
  readyDescription: string;
  startBuilding: string;
  unavailable: string;
}>;

/** New app from a starter (plan 60, lab servers-deploy s1). */
export const newAppTranslations: Readonly<
  Record<
    | 'en'
    | 'ca'
    | 'de'
    | 'es'
    | 'fr'
    | 'it'
    | 'ja'
    | 'pl'
    | 'pt'
    | 'ru'
    | 'zh-Hans'
    | 'zh-Hant',
    Copy
  >
> = {
  en: {
    menuTitle: 'Deploy an app…',
    menuSubtitle: 'Your code, a starter or the catalog',
    title: 'Deploy an app',
    steps: { start: 'Start', describe: 'Describe', create: 'Create' },
    startTitle: 'Deploy an app',
    startDescription:
      'Your code or something that already exists. Nothing is created until you review it.',
    startNewDescription:
      'Pick the closest starting point. Your agent shapes it from there, so nothing here is final.',
    startPick: 'Pick one to continue',
    yourCode: 'Your code',
    startNew: 'Start something new',
    otherProject: 'Another project…',
    codeSubtitle: ({ repository, provider }) => `${repository} · ${provider}`,
    haveCode: 'Already have code?',
    alreadyBuilt: 'Already built',
    builtImage: 'A Docker image',
    builtImageSubtitle: 'From Docker Hub or another registry',
    builtCompose: 'A Compose file',
    builtComposeSubtitle: 'Paste it; Happier keeps it with the app',
    browseCatalog: 'Browse the catalog',
    fromCatalog: 'From the catalog',
    addFolder: 'Add a folder',
    clone: 'Clone a repository',
    describeTitle: 'Describe your app',
    describeDescription:
      'A few sentences is plenty: who it’s for and what they should be able to do. The agent asks if something is unclear.',
    describePlaceholder:
      'For example: a booking page for my yoga classes where people pick a class and pay…',
    describeLabel: 'What your app should do',
    name: 'Name',
    namePlaceholder: 'My app',
    codeLivesIn: 'Code lives in',
    privateRepository: 'Private',
    builtBy: 'Built on',
    on: 'on',
    noComputer: 'No computer yet',
    connectGithub: 'Connect GitHub',
    githubNeeded:
      'Your code lives in a repository on GitHub, so it is backed up and can be published. Connect GitHub to continue.',
    computerNeeded:
      'An agent needs a computer to build on. Add one; nothing you wrote here is lost.',
    addComputer: 'Add a computer',
    machineHomeMismatch: "This computer joined another Home. Use it from that Home, or add a computer here.",
    details: 'Details for developers',
    detailStarter: 'Starter',
    detailBuiltWith: 'Built with',
    detailRevision: 'Revision',
    detailBranch: 'Branch',
    detailAction: 'Action',
    reviewNote: 'Nothing is created until you press Create app',
    create: 'Create app',
    creatingTitle: ({ name }) => `Making ${name}`,
    creatingDescription:
      'This takes under a minute. Then your agent starts building and the project opens.',
    failedTitle: 'One step needs another go',
    failedKept: 'The repository is created. Try again to finish; nothing is created twice.',
    failedNothing: 'Nothing was created. Change what you need, then try again.',
    retry: 'Try again',
    keepsGoing: 'You can close this; it keeps going',
    stepRepository: 'Create the repository',
    stepStarter: ({ name }) => `Add the ${name} starter`,
    stepCheckout: ({ name }) => `Open it on ${name}`,
    stepAgent: 'Start your agent',
    stepAgentWaits: 'Waits for the step above',
    outcomeUnknown:
      'We couldn’t confirm whether the repository was created. Check it before trying again; nothing is created twice.',
    checkRepository: 'Check repository',
    readyTitle: 'Project ready',
    readyDescription:
      'Your project is set up. Start your agent with your description when you’re ready.',
    startBuilding: 'Start building',
    unavailable: 'Couldn’t check GitHub from this computer.',
  },
  ca: {
    menuTitle: 'Desplega una app…',
    menuSubtitle: 'El teu codi, una plantilla o el catàleg',
    title: 'Desplega una app',
    steps: { start: 'Inici', describe: 'Descripció', create: 'Creació' },
    startTitle: 'Desplega una app',
    startDescription:
      'El teu codi o alguna cosa que ja existeix. No es crea res fins que ho revisis.',
    startNewDescription:
      'Tria el punt de partida més proper. L’agent ho adapta a partir d’aquí, així que res no és definitiu.',
    startPick: 'Tria’n un per continuar',
    yourCode: 'El teu codi',
    startNew: 'Comença una cosa nova',
    otherProject: 'Un altre projecte…',
    codeSubtitle: ({ repository, provider }) => `${repository} · ${provider}`,
    haveCode: 'Ja tens codi?',
    alreadyBuilt: 'Ja construït',
    builtImage: 'Una imatge de Docker',
    builtImageSubtitle: 'De Docker Hub o un altre registre',
    builtCompose: 'Un fitxer Compose',
    builtComposeSubtitle: 'Enganxa’l; Happier el desa amb l’app',
    browseCatalog: 'Explora el catàleg',
    fromCatalog: 'Del catàleg',
    addFolder: 'Afegeix una carpeta',
    clone: 'Clona un repositori',
    describeTitle: 'Descriu la teva aplicació',
    describeDescription:
      'N’hi ha prou amb unes frases: per a qui és i què ha de poder fer. L’agent pregunta si alguna cosa no és clara.',
    describePlaceholder:
      'Per exemple: una pàgina de reserves per a les meves classes de ioga on la gent tria una classe i paga…',
    describeLabel: 'Què ha de fer la teva aplicació',
    name: 'Nom',
    namePlaceholder: 'La meva aplicació',
    codeLivesIn: 'El codi viu a',
    privateRepository: 'Privat',
    builtBy: 'Construït a',
    on: 'a',
    noComputer: 'Encara cap ordinador',
    connectGithub: 'Connecta GitHub',
    githubNeeded:
      'El codi viu en un repositori de GitHub, amb còpia de seguretat i llest per publicar. Connecta GitHub per continuar.',
    computerNeeded:
      'Un agent necessita un ordinador on construir. Afegeix-ne un; no es perd res del que has escrit.',
    addComputer: 'Afegeix un ordinador',
    machineHomeMismatch: "Aquest ordinador s’ha unit a una altra llar. Fes-lo servir des d’allà o afegeix un ordinador aquí.",
    details: 'Detalls per a desenvolupadors',
    detailStarter: 'Plantilla',
    detailBuiltWith: 'Fet amb',
    detailRevision: 'Revisió',
    detailBranch: 'Branca',
    detailAction: 'Acció',
    reviewNote: 'No es crea res fins que premis Crea l’aplicació',
    create: 'Crea l’aplicació',
    creatingTitle: ({ name }) => `Creant ${name}`,
    creatingDescription:
      'Triga menys d’un minut. Després l’agent comença a construir i s’obre el projecte.',
    failedTitle: 'Un pas s’ha de tornar a provar',
    failedKept: 'El repositori ja està creat. Torna-ho a provar per acabar; res no es crea dues vegades.',
    failedNothing: 'No s’ha creat res. Canvia el que calgui i torna-ho a provar.',
    retry: 'Torna-ho a provar',
    keepsGoing: 'Pots tancar-ho; continua igualment',
    stepRepository: 'Crea el repositori',
    stepStarter: ({ name }) => `Afegeix la plantilla ${name}`,
    stepCheckout: ({ name }) => `Obre-ho a ${name}`,
    stepAgent: 'Inicia l’agent',
    stepAgentWaits: 'Espera el pas anterior',
    outcomeUnknown:
      'No hem pogut confirmar si s’ha creat el repositori. Comprova-ho abans de tornar-ho a provar; res no es crea dues vegades.',
    checkRepository: 'Comprova el repositori',
    readyTitle: 'Projecte llest',
    readyDescription:
      'El projecte està preparat. Inicia l’agent amb la teva descripció quan vulguis.',
    startBuilding: 'Comença a construir',
    unavailable: 'No s’ha pogut comprovar GitHub des d’aquest ordinador.',
  },
  de: {
    menuTitle: 'App bereitstellen…',
    menuSubtitle: 'Dein Code, eine Vorlage oder der Katalog',
    title: 'App bereitstellen',
    steps: { start: 'Start', describe: 'Beschreiben', create: 'Erstellen' },
    startTitle: 'App bereitstellen',
    startDescription:
      'Dein Code oder etwas, das es schon gibt. Nichts wird erstellt, bevor du es geprüft hast.',
    startNewDescription:
      'Wähle den passendsten Ausgangspunkt. Dein Agent formt es von dort aus, nichts hier ist endgültig.',
    startPick: 'Wähle eins, um fortzufahren',
    yourCode: 'Dein Code',
    startNew: 'Etwas Neues beginnen',
    otherProject: 'Anderes Projekt…',
    codeSubtitle: ({ repository, provider }) => `${repository} · ${provider}`,
    haveCode: 'Schon Code vorhanden?',
    alreadyBuilt: 'Bereits gebaut',
    builtImage: 'Ein Docker-Image',
    builtImageSubtitle: 'Von Docker Hub oder einer anderen Registry',
    builtCompose: 'Eine Compose-Datei',
    builtComposeSubtitle: 'Einfügen; Happier bewahrt sie bei der App auf',
    browseCatalog: 'Katalog durchsuchen',
    fromCatalog: 'Aus dem Katalog',
    addFolder: 'Ordner hinzufügen',
    clone: 'Repository klonen',
    describeTitle: 'Beschreibe deine App',
    describeDescription:
      'Ein paar Sätze reichen: für wen sie ist und was man damit tun können soll. Der Agent fragt nach, wenn etwas unklar ist.',
    describePlaceholder:
      'Zum Beispiel: eine Buchungsseite für meine Yogakurse, auf der man einen Kurs wählt und bezahlt…',
    describeLabel: 'Was deine App tun soll',
    name: 'Name',
    namePlaceholder: 'Meine App',
    codeLivesIn: 'Code liegt in',
    privateRepository: 'Privat',
    builtBy: 'Gebaut auf',
    on: 'auf',
    noComputer: 'Noch kein Computer',
    connectGithub: 'GitHub verbinden',
    githubNeeded:
      'Dein Code liegt in einem GitHub-Repository, gesichert und bereit zum Veröffentlichen. Verbinde GitHub, um fortzufahren.',
    computerNeeded:
      'Ein Agent braucht einen Computer zum Bauen. Füge einen hinzu; nichts von deinem Text geht verloren.',
    addComputer: 'Computer hinzufügen',
    machineHomeMismatch: "Dieser Computer ist einem anderen Zuhause beigetreten. Verwende ihn dort oder füge hier einen Computer hinzu.",
    details: 'Details für Entwickler',
    detailStarter: 'Vorlage',
    detailBuiltWith: 'Gebaut mit',
    detailRevision: 'Revision',
    detailBranch: 'Branch',
    detailAction: 'Aktion',
    reviewNote: 'Nichts wird erstellt, bevor du App erstellen drückst',
    create: 'App erstellen',
    creatingTitle: ({ name }) => `${name} wird erstellt`,
    creatingDescription:
      'Das dauert unter einer Minute. Dann beginnt dein Agent zu bauen und das Projekt öffnet sich.',
    failedTitle: 'Ein Schritt braucht einen neuen Versuch',
    failedKept: 'Das Repository ist erstellt. Versuche es erneut, um abzuschließen; nichts wird doppelt erstellt.',
    failedNothing: 'Es wurde nichts erstellt. Ändere, was nötig ist, und versuche es erneut.',
    retry: 'Erneut versuchen',
    keepsGoing: 'Du kannst das schließen; es läuft weiter',
    stepRepository: 'Repository erstellen',
    stepStarter: ({ name }) => `Vorlage ${name} hinzufügen`,
    stepCheckout: ({ name }) => `Auf ${name} öffnen`,
    stepAgent: 'Agent starten',
    stepAgentWaits: 'Wartet auf den Schritt darüber',
    outcomeUnknown:
      'Wir konnten nicht bestätigen, ob das Repository erstellt wurde. Prüfe es, bevor du es erneut versuchst; nichts wird doppelt erstellt.',
    checkRepository: 'Repository prüfen',
    readyTitle: 'Projekt bereit',
    readyDescription:
      'Dein Projekt ist eingerichtet. Starte deinen Agent mit deiner Beschreibung, wenn du bereit bist.',
    startBuilding: 'Mit dem Bauen beginnen',
    unavailable: 'GitHub konnte von diesem Computer aus nicht geprüft werden.',
  },
  es: {
    menuTitle: 'Desplegar una app…',
    menuSubtitle: 'Tu código, una plantilla o el catálogo',
    title: 'Desplegar una app',
    steps: { start: 'Inicio', describe: 'Descripción', create: 'Creación' },
    startTitle: 'Desplegar una app',
    startDescription:
      'Tu código o algo que ya existe. No se crea nada hasta que lo revises.',
    startNewDescription:
      'Elige el punto de partida más parecido. Tu agente lo adapta desde ahí, así que nada es definitivo.',
    startPick: 'Elige uno para continuar',
    yourCode: 'Tu código',
    startNew: 'Empezar algo nuevo',
    otherProject: 'Otro proyecto…',
    codeSubtitle: ({ repository, provider }) => `${repository} · ${provider}`,
    haveCode: '¿Ya tienes código?',
    alreadyBuilt: 'Ya construido',
    builtImage: 'Una imagen de Docker',
    builtImageSubtitle: 'De Docker Hub u otro registro',
    builtCompose: 'Un archivo Compose',
    builtComposeSubtitle: 'Pégalo; Happier lo guarda con la app',
    browseCatalog: 'Explorar el catálogo',
    fromCatalog: 'Del catálogo',
    addFolder: 'Añadir una carpeta',
    clone: 'Clonar un repositorio',
    describeTitle: 'Describe tu app',
    describeDescription:
      'Bastan unas frases: para quién es y qué deberían poder hacer. El agente pregunta si algo no está claro.',
    describePlaceholder:
      'Por ejemplo: una página de reservas para mis clases de yoga donde la gente elige una clase y paga…',
    describeLabel: 'Qué debe hacer tu app',
    name: 'Nombre',
    namePlaceholder: 'Mi app',
    codeLivesIn: 'El código vive en',
    privateRepository: 'Privado',
    builtBy: 'Creada en',
    on: 'en',
    noComputer: 'Aún no hay ordenador',
    connectGithub: 'Conectar GitHub',
    githubNeeded:
      'Tu código vive en un repositorio de GitHub, con copia de seguridad y listo para publicar. Conecta GitHub para continuar.',
    computerNeeded:
      'Un agente necesita un ordenador donde construir. Añade uno; no se pierde nada de lo que escribiste.',
    addComputer: 'Añadir un ordenador',
    machineHomeMismatch: "Este ordenador se ha unido a otro hogar. Úsalo desde allí o añade un ordenador aquí.",
    details: 'Detalles para desarrolladores',
    detailStarter: 'Plantilla',
    detailBuiltWith: 'Hecha con',
    detailRevision: 'Revisión',
    detailBranch: 'Rama',
    detailAction: 'Acción',
    reviewNote: 'No se crea nada hasta que pulses Crear app',
    create: 'Crear app',
    creatingTitle: ({ name }) => `Creando ${name}`,
    creatingDescription:
      'Tarda menos de un minuto. Después tu agente empieza a construir y se abre el proyecto.',
    failedTitle: 'Un paso necesita otro intento',
    failedKept: 'El repositorio ya está creado. Reintenta para terminar; nada se crea dos veces.',
    failedNothing: 'No se creó nada. Cambia lo que necesites y vuelve a intentarlo.',
    retry: 'Reintentar',
    keepsGoing: 'Puedes cerrar esto; sigue en marcha',
    stepRepository: 'Crear el repositorio',
    stepStarter: ({ name }) => `Añadir la plantilla ${name}`,
    stepCheckout: ({ name }) => `Abrirlo en ${name}`,
    stepAgent: 'Iniciar tu agente',
    stepAgentWaits: 'Espera al paso anterior',
    outcomeUnknown:
      'No pudimos confirmar si se creó el repositorio. Compruébalo antes de reintentar; nada se crea dos veces.',
    checkRepository: 'Comprobar repositorio',
    readyTitle: 'Proyecto listo',
    readyDescription:
      'Tu proyecto está preparado. Inicia tu agente con tu descripción cuando quieras.',
    startBuilding: 'Empezar a construir',
    unavailable: 'No se pudo comprobar GitHub desde este ordenador.',
  },
  fr: {
    menuTitle: 'Déployer une app…',
    menuSubtitle: 'Votre code, un modèle ou le catalogue',
    title: 'Déployer une app',
    steps: { start: 'Départ', describe: 'Description', create: 'Création' },
    startTitle: 'Déployer une app',
    startDescription:
      'Votre code ou quelque chose qui existe déjà. Rien n’est créé avant votre vérification.',
    startNewDescription:
      'Choisissez le point de départ le plus proche. Votre agent l’adapte ensuite, rien n’est définitif.',
    startPick: 'Choisissez-en un pour continuer',
    yourCode: 'Votre code',
    startNew: 'Commencer quelque chose de nouveau',
    otherProject: 'Un autre projet…',
    codeSubtitle: ({ repository, provider }) => `${repository} · ${provider}`,
    haveCode: 'Vous avez déjà du code ?',
    alreadyBuilt: 'Déjà construit',
    builtImage: 'Une image Docker',
    builtImageSubtitle: 'Depuis Docker Hub ou un autre registre',
    builtCompose: 'Un fichier Compose',
    builtComposeSubtitle: 'Collez-le ; Happier le garde avec l’app',
    browseCatalog: 'Parcourir le catalogue',
    fromCatalog: 'Depuis le catalogue',
    addFolder: 'Ajouter un dossier',
    clone: 'Cloner un dépôt',
    describeTitle: 'Décrivez votre app',
    describeDescription:
      'Quelques phrases suffisent : pour qui elle est et ce qu’on doit pouvoir y faire. L’agent pose des questions si quelque chose n’est pas clair.',
    describePlaceholder:
      'Par exemple : une page de réservation pour mes cours de yoga où l’on choisit un cours et paie…',
    describeLabel: 'Ce que votre app doit faire',
    name: 'Nom',
    namePlaceholder: 'Mon app',
    codeLivesIn: 'Le code est dans',
    privateRepository: 'Privé',
    builtBy: 'Construite sur',
    on: 'sur',
    noComputer: 'Pas encore d’ordinateur',
    connectGithub: 'Connecter GitHub',
    githubNeeded:
      'Votre code vit dans un dépôt GitHub, sauvegardé et prêt à publier. Connectez GitHub pour continuer.',
    computerNeeded:
      'Un agent a besoin d’un ordinateur pour construire. Ajoutez-en un ; rien de ce que vous avez écrit n’est perdu.',
    addComputer: 'Ajouter un ordinateur',
    machineHomeMismatch: "Cet ordinateur a rejoint un autre foyer. Utilisez-le depuis ce foyer ou ajoutez un ordinateur ici.",
    details: 'Détails pour les développeurs',
    detailStarter: 'Modèle',
    detailBuiltWith: 'Construit avec',
    detailRevision: 'Révision',
    detailBranch: 'Branche',
    detailAction: 'Action',
    reviewNote: 'Rien n’est créé avant que vous appuyiez sur Créer l’app',
    create: 'Créer l’app',
    creatingTitle: ({ name }) => `Création de ${name}`,
    creatingDescription:
      'Cela prend moins d’une minute. Ensuite votre agent commence à construire et le projet s’ouvre.',
    failedTitle: 'Une étape doit être relancée',
    failedKept: 'Le dépôt est créé. Réessayez pour terminer ; rien n’est créé deux fois.',
    failedNothing: 'Rien n’a été créé. Modifiez ce qu’il faut, puis réessayez.',
    retry: 'Réessayer',
    keepsGoing: 'Vous pouvez fermer ; cela continue',
    stepRepository: 'Créer le dépôt',
    stepStarter: ({ name }) => `Ajouter le modèle ${name}`,
    stepCheckout: ({ name }) => `L’ouvrir sur ${name}`,
    stepAgent: 'Démarrer votre agent',
    stepAgentWaits: 'Attend l’étape précédente',
    outcomeUnknown:
      'Nous n’avons pas pu confirmer la création du dépôt. Vérifiez-le avant de réessayer ; rien n’est créé deux fois.',
    checkRepository: 'Vérifier le dépôt',
    readyTitle: 'Projet prêt',
    readyDescription:
      'Votre projet est en place. Démarrez votre agent avec votre description quand vous voulez.',
    startBuilding: 'Commencer à construire',
    unavailable: 'Impossible de vérifier GitHub depuis cet ordinateur.',
  },
  it: {
    menuTitle: 'Distribuisci un’app…',
    menuSubtitle: 'Il tuo codice, un modello o il catalogo',
    title: 'Distribuisci un’app',
    steps: { start: 'Inizio', describe: 'Descrizione', create: 'Creazione' },
    startTitle: 'Distribuisci un’app',
    startDescription:
      'Il tuo codice o qualcosa che esiste già. Non viene creato nulla finché non lo controlli.',
    startNewDescription:
      'Scegli il punto di partenza più vicino. Il tuo agente lo adatta da lì, quindi niente è definitivo.',
    startPick: 'Scegline uno per continuare',
    yourCode: 'Il tuo codice',
    startNew: 'Inizia qualcosa di nuovo',
    otherProject: 'Un altro progetto…',
    codeSubtitle: ({ repository, provider }) => `${repository} · ${provider}`,
    haveCode: 'Hai già del codice?',
    alreadyBuilt: 'Già pronto',
    builtImage: 'Un’immagine Docker',
    builtImageSubtitle: 'Da Docker Hub o un altro registro',
    builtCompose: 'Un file Compose',
    builtComposeSubtitle: 'Incollalo; Happier lo conserva con l’app',
    browseCatalog: 'Sfoglia il catalogo',
    fromCatalog: 'Dal catalogo',
    addFolder: 'Aggiungi una cartella',
    clone: 'Clona un repository',
    describeTitle: 'Descrivi la tua app',
    describeDescription:
      'Bastano poche frasi: per chi è e cosa si deve poter fare. L’agente chiede se qualcosa non è chiaro.',
    describePlaceholder:
      'Per esempio: una pagina di prenotazione per i miei corsi di yoga dove si sceglie un corso e si paga…',
    describeLabel: 'Cosa deve fare la tua app',
    name: 'Nome',
    namePlaceholder: 'La mia app',
    codeLivesIn: 'Il codice vive in',
    privateRepository: 'Privato',
    builtBy: 'Costruita su',
    on: 'su',
    noComputer: 'Nessun computer ancora',
    connectGithub: 'Collega GitHub',
    githubNeeded:
      'Il tuo codice vive in un repository GitHub, salvato e pronto da pubblicare. Collega GitHub per continuare.',
    computerNeeded:
      'Un agente ha bisogno di un computer su cui costruire. Aggiungine uno; niente di ciò che hai scritto va perso.',
    addComputer: 'Aggiungi un computer',
    machineHomeMismatch: "Questo computer si è unito a un’altra Home. Usalo da quella Home oppure aggiungi un computer qui.",
    details: 'Dettagli per sviluppatori',
    detailStarter: 'Modello',
    detailBuiltWith: 'Fatto con',
    detailRevision: 'Revisione',
    detailBranch: 'Branch',
    detailAction: 'Azione',
    reviewNote: 'Non viene creato nulla finché non premi Crea app',
    create: 'Crea app',
    creatingTitle: ({ name }) => `Creazione di ${name}`,
    creatingDescription:
      'Ci vuole meno di un minuto. Poi il tuo agente inizia a costruire e il progetto si apre.',
    failedTitle: 'Un passaggio va ritentato',
    failedKept: 'Il repository è stato creato. Riprova per finire; nulla viene creato due volte.',
    failedNothing: 'Non è stato creato nulla. Modifica ciò che serve e riprova.',
    retry: 'Riprova',
    keepsGoing: 'Puoi chiudere; continua comunque',
    stepRepository: 'Crea il repository',
    stepStarter: ({ name }) => `Aggiungi il modello ${name}`,
    stepCheckout: ({ name }) => `Aprilo su ${name}`,
    stepAgent: 'Avvia il tuo agente',
    stepAgentWaits: 'Attende il passaggio sopra',
    outcomeUnknown:
      'Non abbiamo potuto confermare se il repository è stato creato. Controllalo prima di riprovare; nulla viene creato due volte.',
    checkRepository: 'Controlla il repository',
    readyTitle: 'Progetto pronto',
    readyDescription:
      'Il progetto è pronto. Avvia il tuo agente con la tua descrizione quando vuoi.',
    startBuilding: 'Inizia a costruire',
    unavailable: 'Impossibile verificare GitHub da questo computer.',
  },
  ja: {
    menuTitle: 'アプリをデプロイ…',
    menuSubtitle: '自分のコード、スターター、カタログから',
    title: 'アプリをデプロイ',
    steps: { start: '開始', describe: '説明', create: '作成' },
    startTitle: 'アプリをデプロイ',
    startDescription:
      '自分のコード、またはすでにあるもの。確認するまで何も作成されません。',
    startNewDescription:
      'いちばん近い出発点を選んでください。そこからエージェントが形にするので、ここで決めたことは変えられます。',
    startPick: '続けるには1つ選んでください',
    yourCode: '自分のコード',
    startNew: '新しく始める',
    otherProject: '別のプロジェクト…',
    codeSubtitle: ({ repository, provider }) => `${repository} · ${provider}`,
    haveCode: 'すでにコードがありますか？',
    alreadyBuilt: 'ビルド済み',
    builtImage: 'Docker イメージ',
    builtImageSubtitle: 'Docker Hub などのレジストリから',
    builtCompose: 'Compose ファイル',
    builtComposeSubtitle: '貼り付けると Happier がアプリと一緒に保存します',
    browseCatalog: 'カタログを見る',
    fromCatalog: 'カタログから',
    addFolder: 'フォルダを追加',
    clone: 'リポジトリをクローン',
    describeTitle: 'アプリを説明する',
    describeDescription:
      '数行で十分です。誰のためのもので、何ができるべきか。不明な点はエージェントが質問します。',
    describePlaceholder:
      '例：ヨガクラスの予約ページ。クラスを選んで支払いができる…',
    describeLabel: 'アプリでできること',
    name: '名前',
    namePlaceholder: 'マイアプリ',
    codeLivesIn: 'コードの保存先',
    privateRepository: '非公開',
    builtBy: '作成場所',
    on: '上で',
    noComputer: 'まだコンピューターがありません',
    connectGithub: 'GitHub を接続',
    githubNeeded:
      'コードは GitHub のリポジトリに保存され、バックアップされ公開できます。続けるには GitHub を接続してください。',
    computerNeeded:
      'エージェントが作業するにはコンピューターが必要です。追加しても、ここに書いた内容は失われません。',
    addComputer: 'コンピューターを追加',
    machineHomeMismatch: "このコンピューターは別のホームに参加しました。そのホームから使用するか、ここにコンピューターを追加してください。",
    details: '開発者向けの詳細',
    detailStarter: 'スターター',
    detailBuiltWith: '使用技術',
    detailRevision: 'リビジョン',
    detailBranch: 'ブランチ',
    detailAction: 'アクション',
    reviewNote: '「アプリを作成」を押すまで何も作成されません',
    create: 'アプリを作成',
    creatingTitle: ({ name }) => `${name} を作成中`,
    creatingDescription:
      '1分もかかりません。その後エージェントが作り始め、プロジェクトが開きます。',
    failedTitle: 'もう一度試す必要がある手順があります',
    failedKept: 'リポジトリは作成済みです。もう一度試すと完了します。二重に作成されることはありません。',
    failedNothing: '何も作成されていません。必要な点を変更してから、もう一度試してください。',
    retry: 'もう一度試す',
    keepsGoing: '閉じても続行されます',
    stepRepository: 'リポジトリを作成',
    stepStarter: ({ name }) => `${name} スターターを追加`,
    stepCheckout: ({ name }) => `${name} で開く`,
    stepAgent: 'エージェントを開始',
    stepAgentWaits: '前の手順を待っています',
    outcomeUnknown:
      'リポジトリが作成されたか確認できませんでした。もう一度試す前に確認してください。二重に作成されることはありません。',
    checkRepository: 'リポジトリを確認',
    readyTitle: 'プロジェクトの準備ができました',
    readyDescription:
      'プロジェクトの準備ができました。準備ができたら説明を添えてエージェントを開始してください。',
    startBuilding: '作り始める',
    unavailable: 'このコンピューターから GitHub を確認できませんでした。',
  },
  pl: {
    menuTitle: 'Wdróż aplikację…',
    menuSubtitle: 'Twój kod, szablon lub katalog',
    title: 'Wdróż aplikację',
    steps: { start: 'Start', describe: 'Opis', create: 'Tworzenie' },
    startTitle: 'Wdróż aplikację',
    startDescription:
      'Twój kod lub coś, co już istnieje. Nic nie powstanie, dopóki tego nie sprawdzisz.',
    startNewDescription:
      'Wybierz najbliższy punkt wyjścia. Agent dopracuje go dalej, więc nic tu nie jest ostateczne.',
    startPick: 'Wybierz jeden, aby kontynuować',
    yourCode: 'Twój kod',
    startNew: 'Zacznij coś nowego',
    otherProject: 'Inny projekt…',
    codeSubtitle: ({ repository, provider }) => `${repository} · ${provider}`,
    haveCode: 'Masz już kod?',
    alreadyBuilt: 'Już zbudowane',
    builtImage: 'Obraz Dockera',
    builtImageSubtitle: 'Z Docker Hub lub innego rejestru',
    builtCompose: 'Plik Compose',
    builtComposeSubtitle: 'Wklej go; Happier zachowa go z aplikacją',
    browseCatalog: 'Przeglądaj katalog',
    fromCatalog: 'Z katalogu',
    addFolder: 'Dodaj folder',
    clone: 'Sklonuj repozytorium',
    describeTitle: 'Opisz swoją aplikację',
    describeDescription:
      'Wystarczy kilka zdań: dla kogo jest i co ma umożliwiać. Agent zapyta, jeśli coś będzie niejasne.',
    describePlaceholder:
      'Na przykład: strona rezerwacji moich zajęć jogi, gdzie można wybrać zajęcia i zapłacić…',
    describeLabel: 'Co ma robić twoja aplikacja',
    name: 'Nazwa',
    namePlaceholder: 'Moja aplikacja',
    codeLivesIn: 'Kod jest w',
    privateRepository: 'Prywatne',
    builtBy: 'Budowana na',
    on: 'na',
    noComputer: 'Jeszcze bez komputera',
    connectGithub: 'Połącz GitHub',
    githubNeeded:
      'Twój kod jest w repozytorium GitHub, z kopią zapasową i gotowy do publikacji. Połącz GitHub, aby kontynuować.',
    computerNeeded:
      'Agent potrzebuje komputera, na którym zbuduje aplikację. Dodaj go; nic z tego, co napisano, nie zginie.',
    addComputer: 'Dodaj komputer',
    machineHomeMismatch: "Ten komputer dołączył do innego domu. Użyj go z tamtego domu lub dodaj komputer tutaj.",
    details: 'Szczegóły dla programistów',
    detailStarter: 'Szablon',
    detailBuiltWith: 'Zbudowane z',
    detailRevision: 'Rewizja',
    detailBranch: 'Gałąź',
    detailAction: 'Akcja',
    reviewNote: 'Nic nie powstanie, dopóki nie naciśniesz Utwórz aplikację',
    create: 'Utwórz aplikację',
    creatingTitle: ({ name }) => `Tworzenie: ${name}`,
    creatingDescription:
      'To trwa krócej niż minutę. Potem agent zaczyna budować i otwiera się projekt.',
    failedTitle: 'Jeden krok trzeba powtórzyć',
    failedKept: 'Repozytorium jest utworzone. Spróbuj ponownie, aby dokończyć; nic nie powstanie dwa razy.',
    failedNothing: 'Nic nie zostało utworzone. Zmień, co trzeba, i spróbuj ponownie.',
    retry: 'Spróbuj ponownie',
    keepsGoing: 'Możesz to zamknąć; działa dalej',
    stepRepository: 'Utwórz repozytorium',
    stepStarter: ({ name }) => `Dodaj szablon ${name}`,
    stepCheckout: ({ name }) => `Otwórz na ${name}`,
    stepAgent: 'Uruchom agenta',
    stepAgentWaits: 'Czeka na krok powyżej',
    outcomeUnknown:
      'Nie udało się potwierdzić, czy repozytorium powstało. Sprawdź je przed ponowną próbą; nic nie powstanie dwa razy.',
    checkRepository: 'Sprawdź repozytorium',
    readyTitle: 'Projekt gotowy',
    readyDescription:
      'Projekt jest gotowy. Uruchom agenta ze swoim opisem, kiedy zechcesz.',
    startBuilding: 'Zacznij budować',
    unavailable: 'Nie udało się sprawdzić GitHuba z tego komputera.',
  },
  pt: {
    menuTitle: 'Implantar um app…',
    menuSubtitle: 'Seu código, um modelo ou o catálogo',
    title: 'Implantar um app',
    steps: { start: 'Início', describe: 'Descrição', create: 'Criação' },
    startTitle: 'Implantar um app',
    startDescription:
      'Seu código ou algo que já existe. Nada é criado até você revisar.',
    startNewDescription:
      'Escolha o ponto de partida mais próximo. Seu agente adapta a partir daí, então nada aqui é definitivo.',
    startPick: 'Escolha um para continuar',
    yourCode: 'Seu código',
    startNew: 'Começar algo novo',
    otherProject: 'Outro projeto…',
    codeSubtitle: ({ repository, provider }) => `${repository} · ${provider}`,
    haveCode: 'Já tem código?',
    alreadyBuilt: 'Já construído',
    builtImage: 'Uma imagem Docker',
    builtImageSubtitle: 'Do Docker Hub ou de outro registro',
    builtCompose: 'Um arquivo Compose',
    builtComposeSubtitle: 'Cole-o; o Happier guarda com o app',
    browseCatalog: 'Explorar o catálogo',
    fromCatalog: 'Do catálogo',
    addFolder: 'Adicionar uma pasta',
    clone: 'Clonar um repositório',
    describeTitle: 'Descreva seu app',
    describeDescription:
      'Algumas frases bastam: para quem é e o que deve ser possível fazer. O agente pergunta se algo não estiver claro.',
    describePlaceholder:
      'Por exemplo: uma página de reservas para minhas aulas de ioga onde as pessoas escolhem uma aula e pagam…',
    describeLabel: 'O que seu app deve fazer',
    name: 'Nome',
    namePlaceholder: 'Meu app',
    codeLivesIn: 'O código fica em',
    privateRepository: 'Privado',
    builtBy: 'Criado em',
    on: 'em',
    noComputer: 'Ainda sem computador',
    connectGithub: 'Conectar GitHub',
    githubNeeded:
      'Seu código fica em um repositório no GitHub, com backup e pronto para publicar. Conecte o GitHub para continuar.',
    computerNeeded:
      'Um agente precisa de um computador para construir. Adicione um; nada do que você escreveu se perde.',
    addComputer: 'Adicionar um computador',
    machineHomeMismatch: "Este computador entrou em outra Home. Use-o por lá ou adicione um computador aqui.",
    details: 'Detalhes para desenvolvedores',
    detailStarter: 'Modelo',
    detailBuiltWith: 'Feito com',
    detailRevision: 'Revisão',
    detailBranch: 'Branch',
    detailAction: 'Ação',
    reviewNote: 'Nada é criado até você tocar em Criar app',
    create: 'Criar app',
    creatingTitle: ({ name }) => `Criando ${name}`,
    creatingDescription:
      'Leva menos de um minuto. Depois seu agente começa a construir e o projeto abre.',
    failedTitle: 'Uma etapa precisa de nova tentativa',
    failedKept: 'O repositório já foi criado. Tente de novo para terminar; nada é criado duas vezes.',
    failedNothing: 'Nada foi criado. Altere o que precisar e tente de novo.',
    retry: 'Tentar de novo',
    keepsGoing: 'Você pode fechar; continua rodando',
    stepRepository: 'Criar o repositório',
    stepStarter: ({ name }) => `Adicionar o modelo ${name}`,
    stepCheckout: ({ name }) => `Abrir em ${name}`,
    stepAgent: 'Iniciar seu agente',
    stepAgentWaits: 'Aguarda a etapa acima',
    outcomeUnknown:
      'Não foi possível confirmar se o repositório foi criado. Verifique antes de tentar de novo; nada é criado duas vezes.',
    checkRepository: 'Verificar repositório',
    readyTitle: 'Projeto pronto',
    readyDescription:
      'Seu projeto está configurado. Inicie seu agente com sua descrição quando quiser.',
    startBuilding: 'Começar a construir',
    unavailable: 'Não foi possível verificar o GitHub neste computador.',
  },
  ru: {
    menuTitle: 'Развернуть приложение…',
    menuSubtitle: 'Ваш код, шаблон или каталог',
    title: 'Развернуть приложение',
    steps: { start: 'Начало', describe: 'Описание', create: 'Создание' },
    startTitle: 'Развернуть приложение',
    startDescription:
      'Ваш код или то, что уже есть. Ничего не создаётся, пока вы не проверите.',
    startNewDescription:
      'Выберите самую близкую основу. Агент доработает её дальше, так что здесь ничего не окончательно.',
    startPick: 'Выберите вариант, чтобы продолжить',
    yourCode: 'Ваш код',
    startNew: 'Начать новое',
    otherProject: 'Другой проект…',
    codeSubtitle: ({ repository, provider }) => `${repository} · ${provider}`,
    haveCode: 'Уже есть код?',
    alreadyBuilt: 'Уже собрано',
    builtImage: 'Образ Docker',
    builtImageSubtitle: 'Из Docker Hub или другого реестра',
    builtCompose: 'Файл Compose',
    builtComposeSubtitle: 'Вставьте его — Happier сохранит его вместе с приложением',
    browseCatalog: 'Открыть каталог',
    fromCatalog: 'Из каталога',
    addFolder: 'Добавить папку',
    clone: 'Клонировать репозиторий',
    describeTitle: 'Опишите приложение',
    describeDescription:
      'Хватит пары предложений: для кого оно и что в нём можно делать. Агент спросит, если что-то неясно.',
    describePlaceholder:
      'Например: страница записи на мои занятия йогой, где можно выбрать занятие и оплатить…',
    describeLabel: 'Что должно делать приложение',
    name: 'Название',
    namePlaceholder: 'Моё приложение',
    codeLivesIn: 'Код хранится в',
    privateRepository: 'Приватный',
    builtBy: 'Создаётся на',
    on: 'на',
    noComputer: 'Пока нет компьютера',
    connectGithub: 'Подключить GitHub',
    githubNeeded:
      'Код хранится в репозитории GitHub — с резервной копией и готовым к публикации. Подключите GitHub, чтобы продолжить.',
    computerNeeded:
      'Агенту нужен компьютер для работы. Добавьте его — написанное здесь не пропадёт.',
    addComputer: 'Добавить компьютер',
    machineHomeMismatch: "Этот компьютер подключился к другому дому. Используйте его оттуда или добавьте компьютер здесь.",
    details: 'Подробности для разработчиков',
    detailStarter: 'Шаблон',
    detailBuiltWith: 'Технологии',
    detailRevision: 'Ревизия',
    detailBranch: 'Ветка',
    detailAction: 'Действие',
    reviewNote: 'Ничего не создаётся, пока вы не нажмёте «Создать приложение»',
    create: 'Создать приложение',
    creatingTitle: ({ name }) => `Создаём ${name}`,
    creatingDescription:
      'Это займёт меньше минуты. Затем агент начнёт работу и откроется проект.',
    failedTitle: 'Один шаг нужно повторить',
    failedKept: 'Репозиторий создан. Повторите, чтобы завершить, — дважды ничего не создаётся.',
    failedNothing: 'Ничего не создано. Измените нужное и повторите.',
    retry: 'Повторить',
    keepsGoing: 'Можно закрыть — работа продолжится',
    stepRepository: 'Создать репозиторий',
    stepStarter: ({ name }) => `Добавить шаблон «${name}»`,
    stepCheckout: ({ name }) => `Открыть на ${name}`,
    stepAgent: 'Запустить агента',
    stepAgentWaits: 'Ждёт предыдущего шага',
    outcomeUnknown:
      'Не удалось подтвердить, создан ли репозиторий. Проверьте его перед повтором — дважды ничего не создаётся.',
    checkRepository: 'Проверить репозиторий',
    readyTitle: 'Проект готов',
    readyDescription:
      'Проект настроен. Запустите агента с вашим описанием, когда будете готовы.',
    startBuilding: 'Начать работу',
    unavailable: 'Не удалось проверить GitHub с этого компьютера.',
  },
  'zh-Hans': {
    menuTitle: '部署应用…',
    menuSubtitle: '你的代码、模板或目录',
    title: '部署应用',
    steps: { start: '开始', describe: '描述', create: '创建' },
    startTitle: '部署应用',
    startDescription:
      '你的代码，或已有的东西。在你确认之前不会创建任何内容。',
    startNewDescription:
      '选择最接近的起点。之后由你的智能体继续塑造，这里的选择都不是最终的。',
    startPick: '选择一个以继续',
    yourCode: '你的代码',
    startNew: '开始新项目',
    otherProject: '其他项目…',
    codeSubtitle: ({ repository, provider }) => `${repository} · ${provider}`,
    haveCode: '已经有代码了？',
    alreadyBuilt: '已构建',
    builtImage: 'Docker 镜像',
    builtImageSubtitle: '来自 Docker Hub 或其他镜像仓库',
    builtCompose: 'Compose 文件',
    builtComposeSubtitle: '粘贴即可，Happier 会随应用保存',
    browseCatalog: '浏览目录',
    fromCatalog: '从目录中选择',
    addFolder: '添加文件夹',
    clone: '克隆仓库',
    describeTitle: '描述你的应用',
    describeDescription:
      '几句话就够了：给谁用，能做什么。不清楚的地方智能体会问你。',
    describePlaceholder: '例如：我的瑜伽课预约页面，大家可以选课并付款…',
    describeLabel: '你的应用要做什么',
    name: '名称',
    namePlaceholder: '我的应用',
    codeLivesIn: '代码存放于',
    privateRepository: '私有',
    builtBy: '构建于',
    on: '在',
    noComputer: '还没有电脑',
    connectGithub: '连接 GitHub',
    githubNeeded:
      '你的代码存放在 GitHub 仓库中，有备份且可以发布。连接 GitHub 以继续。',
    computerNeeded:
      '智能体需要一台电脑来构建。添加一台吧，你写的内容不会丢失。',
    addComputer: '添加电脑',
    machineHomeMismatch: "这台电脑已加入另一个主页。请从那个主页使用它，或在此处添加一台电脑。",
    details: '开发者详情',
    detailStarter: '模板',
    detailBuiltWith: '技术',
    detailRevision: '修订',
    detailBranch: '分支',
    detailAction: '操作',
    reviewNote: '按下“创建应用”之前不会创建任何内容',
    create: '创建应用',
    creatingTitle: ({ name }) => `正在创建 ${name}`,
    creatingDescription: '不到一分钟。之后智能体开始构建，项目随即打开。',
    failedTitle: '有一步需要重试',
    failedKept: '仓库已创建。重试即可完成，不会重复创建。',
    failedNothing: '未创建任何内容。修改需要的地方后再试一次。',
    retry: '重试',
    keepsGoing: '可以关闭，它会继续进行',
    stepRepository: '创建仓库',
    stepStarter: ({ name }) => `添加 ${name} 模板`,
    stepCheckout: ({ name }) => `在 ${name} 上打开`,
    stepAgent: '启动智能体',
    stepAgentWaits: '等待上一步',
    outcomeUnknown: '无法确认仓库是否已创建。重试前请先检查；不会重复创建。',
    checkRepository: '检查仓库',
    readyTitle: '项目已就绪',
    readyDescription: '项目已设置好。准备好后，用你的描述启动智能体。',
    startBuilding: '开始构建',
    unavailable: '无法从这台电脑检查 GitHub。',
  },
  'zh-Hant': {
    menuTitle: '部署應用程式…',
    menuSubtitle: '你的程式碼、範本或目錄',
    title: '部署應用程式',
    steps: { start: '開始', describe: '描述', create: '建立' },
    startTitle: '部署應用程式',
    startDescription:
      '你的程式碼，或已有的東西。在你確認之前不會建立任何內容。',
    startNewDescription:
      '選擇最接近的起點。之後由你的代理程式繼續塑造，這裡的選擇都不是最終的。',
    startPick: '選擇一個以繼續',
    yourCode: '你的程式碼',
    startNew: '開始新專案',
    otherProject: '其他專案…',
    codeSubtitle: ({ repository, provider }) => `${repository} · ${provider}`,
    haveCode: '已經有程式碼了？',
    alreadyBuilt: '已建置',
    builtImage: 'Docker 映像檔',
    builtImageSubtitle: '來自 Docker Hub 或其他映像檔倉庫',
    builtCompose: 'Compose 檔案',
    builtComposeSubtitle: '貼上即可，Happier 會隨應用程式保存',
    browseCatalog: '瀏覽目錄',
    fromCatalog: '從目錄中選擇',
    addFolder: '新增資料夾',
    clone: '複製儲存庫',
    describeTitle: '描述你的應用程式',
    describeDescription:
      '幾句話就夠了：給誰用，能做什麼。不清楚的地方代理程式會問你。',
    describePlaceholder: '例如：我的瑜伽課預約頁面，大家可以選課並付款…',
    describeLabel: '你的應用程式要做什麼',
    name: '名稱',
    namePlaceholder: '我的應用程式',
    codeLivesIn: '程式碼存放於',
    privateRepository: '私人',
    builtBy: '建構於',
    on: '在',
    noComputer: '還沒有電腦',
    connectGithub: '連接 GitHub',
    githubNeeded:
      '你的程式碼存放在 GitHub 儲存庫中，有備份且可以發佈。連接 GitHub 以繼續。',
    computerNeeded:
      '代理程式需要一台電腦來建構。新增一台吧，你寫的內容不會遺失。',
    addComputer: '新增電腦',
    machineHomeMismatch: "這台電腦已加入另一個主頁。請從那個主頁使用它，或在此處新增一台電腦。",
    details: '開發者詳細資訊',
    detailStarter: '範本',
    detailBuiltWith: '技術',
    detailRevision: '修訂',
    detailBranch: '分支',
    detailAction: '動作',
    reviewNote: '按下「建立應用程式」之前不會建立任何內容',
    create: '建立應用程式',
    creatingTitle: ({ name }) => `正在建立 ${name}`,
    creatingDescription: '不到一分鐘。之後代理程式開始建構，專案隨即開啟。',
    failedTitle: '有一步需要重試',
    failedKept: '儲存庫已建立。重試即可完成，不會重複建立。',
    failedNothing: '未建立任何內容。修改需要的地方後再試一次。',
    retry: '重試',
    keepsGoing: '可以關閉，它會繼續進行',
    stepRepository: '建立儲存庫',
    stepStarter: ({ name }) => `新增 ${name} 範本`,
    stepCheckout: ({ name }) => `在 ${name} 上開啟`,
    stepAgent: '啟動代理程式',
    stepAgentWaits: '等待上一步',
    outcomeUnknown: '無法確認儲存庫是否已建立。重試前請先檢查；不會重複建立。',
    checkRepository: '檢查儲存庫',
    readyTitle: '專案已就緒',
    readyDescription: '專案已設定好。準備好後，用你的描述啟動代理程式。',
    startBuilding: '開始建構',
    unavailable: '無法從這台電腦檢查 GitHub。',
  },
};
