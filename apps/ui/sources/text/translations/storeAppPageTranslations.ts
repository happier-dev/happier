import { templateChoicesTranslations, type TemplateChoicesTranslation } from './templateChoicesTranslations';

// Store → an App listing and its preparation review (STORE-APP-UI). Mounted under `capabilities.store.appPage`; the Apps kind copy is storeAppTranslations.ts.

type Count = Readonly<{ count: number }>;
type Name = Readonly<{ name: string }>;
type Machine = Readonly<{ machine: string }>;
type Port = Readonly<{ service: string; port: number }>;
type Size = Readonly<{ size: string }>;
type Project = Readonly<{ project: string }>;

export type StoreAppPageTranslation = Readonly<{
  choices: TemplateChoicesTranslation;
  install: string;
  installNote: string;
  needsReviewHint: string;
  runsLabel: string;
  services: (params: Count) => string;
  needsLabel: string;
  memory: (params: Size) => string;
  licenceLabel: string;
  firstRunLabel: string;
  firstRunValue: string;
  dataLabel: string;
  volumes: (params: Count) => string;
  reachTitle: string;
  addressTitle: string;
  addressBody: (params: Port) => string;
  internalTitle: (params: Port) => string;
  keptTitle: (params: Count) => string;
  keptBody: (params: Readonly<{ count: number }>) => string;
  secretsTitle: (params: Count) => string;
  secretsBody: string;
  firstRunTitle: string;
  firstRunBody: string;
  reviewTitle: string;
  reviewDescription: string;
  prepareTitle: (params: Name) => string;
  prepareDescription: string;
  whereTitle: string;
  whereDescription: (params: Name) => string;
  noMachine: string;
  firstRunWarningTitle: string;
  firstRunWarningBody: string;
  projectTitle: string;
  projectDescription: string;
  projectNew: string;
  projectNewHint: string;
  projectNameLabel: string;
  projectOwnerLabel: string;
  projectOwnerYou: string;
  nameProject: string;
  projectsLoading: string;
  deploysTitle: string;
  deploysDescription: string;
  controllerLabel: string;
  controllerDefault: string;
  chooseMachine: string;
  nameEnvironment: string;
  domainAddress: string;
  domainAddressFor: (params: Readonly<{ service: string }>) => string;
  domainDnsHint: (params: Readonly<{ route: string }>) => string;
  domainPlaceholder: string;
  domainRequired: string;
  domainInvalid: string;
  chooseProject: string;
  projectPlaceholder: string;
  review: string;
  back: string;
  preparedTitle: string;
  preparedDescription: string;
  createOn: (params: Machine & Name) => string;
  nameAndAddressTitle: string;
  defaultsTitle: string;
  managersDeploy: string;
  inNewProject: (params: Name) => string;
  inProject: (params: Project) => string;
  refused: (params: Name) => string;
  approvalWaiting: string;
  approvalDescription: string;
}>;

const en: StoreAppPageTranslation = {
  choices: templateChoicesTranslations.en,
  install: 'Install and deploy',
  installNote: 'Next you choose the Machine that runs it.',
  needsReviewHint: 'Needs review before it can install',
  runsLabel: 'Runs',
  services: ({ count }) => (count === 1 ? '1 service' : `${count} services`),
  needsLabel: 'Needs',
  memory: ({ size }) => `About ${size}`,
  licenceLabel: 'Licence',
  firstRunLabel: 'First run',
  firstRunValue: 'You create the admin',
  dataLabel: 'Data',
  volumes: ({ count }) => (count === 1 ? '1 volume' : `${count} volumes`),
  reachTitle: 'What it runs and can reach',
  addressTitle: 'Your address, with HTTPS',
  addressBody: ({ service, port }) =>
    `Happier routes it to ${service} on port ${port}`,
  internalTitle: ({ service, port }) => `${service} on port ${port}`,
  keptTitle: ({ count }) =>
    count === 1
      ? 'One volume, kept across deploys'
      : `${count} volumes, kept across deploys`,
  keptBody: ({ count }) => (count === 1 ? 'Back it up from its environment once it runs' : 'Back them up from its environment once it runs'),
  secretsTitle: ({ count }) =>
    count === 1
      ? 'One secret, generated and saved for you'
      : `${count} secrets, generated and saved for you`,
  secretsBody: 'Kept in Saved Secrets, never shown here',
  firstRunTitle: 'Whoever opens it first creates the admin',
  firstRunBody:
    'Open it right after it starts; its page reminds you until you do',
  reviewTitle: 'Needs review',
  reviewDescription:
    'Happier can’t map these settings from the template yet. Nothing installs until each one is mapped.',
  prepareTitle: ({ name }) => `Install ${name}`,
  prepareDescription: 'Nothing is created until you confirm.',
  whereTitle: 'Where it runs',
  whereDescription: ({ name }) =>
    `The Machine that runs ${name} and keeps its data.`,
  noMachine: 'Connect a Machine to run apps',
  firstRunWarningTitle: 'Create your admin account first',
  firstRunWarningBody: 'Until you do, whoever opens the address first can create it.',
  projectTitle: 'Project',
  projectDescription: 'Where you’ll find it later.',
  projectNew: 'New project',
  projectNewHint: 'Starts empty, just for this App',
  projectNameLabel: 'Project name',
  projectOwnerLabel: 'Owner',
  projectOwnerYou: 'You',
  nameProject: 'Name the new project',
  projectsLoading: 'Loading projects…',
  deploysTitle: 'Deploys',
  deploysDescription:
    'Your Account’s choice applies unless you pick a Machine here.',
  controllerLabel: 'Runs deploys from',
  controllerDefault: 'Your usual Machine',
  chooseMachine: 'Choose a Machine first',
  nameEnvironment: 'Give it a name first',
  domainAddress: 'Address',
  domainAddressFor: ({ service }) => `Address for ${service}`,
  domainDnsHint: ({ route }) => `Point this name's DNS at the Machine; ${route}`,
  domainPlaceholder: 'example.com',
  domainRequired: 'This app needs a public address, like example.com.',
  domainInvalid: "Enter a valid hostname, such as app.example.com.",
  chooseProject: 'Choose a project first',
  projectPlaceholder: 'Choose a project',
  review: 'Review',
  back: 'Back',
  preparedTitle: 'Ready to install',
  preparedDescription: 'This is everything that will happen.',
  createOn: ({ name, machine }) => `Create “${name}” on ${machine}`,
  nameAndAddressTitle: 'Name and address',
  defaultsTitle: 'Deploy settings',
  managersDeploy: 'Managers can deploy',
  inNewProject: ({ name }) => `In a new project, ${name} · no repository`,
  inProject: ({ project }) => `In ${project}`,
  refused: ({ name }) => `Couldn’t prepare ${name}`,
  approvalWaiting: 'Waiting for approval',
  approvalDescription: 'Once it’s approved, review it again here.',
};

const ca: StoreAppPageTranslation = {
  choices: templateChoicesTranslations.ca,
  install: 'Instal·la i desplega',
  installNote: 'A continuació tries la màquina que l’executa.',
  needsReviewHint: 'Cal revisar-la abans d’instal·lar-la',
  runsLabel: 'Executa',
  services: ({ count }) => (count === 1 ? '1 servei' : `${count} serveis`),
  needsLabel: 'Necessita',
  memory: ({ size }) => `Uns ${size}`,
  licenceLabel: 'Llicència',
  firstRunLabel: 'Primer ús',
  firstRunValue: 'Tu crees l’administrador',
  dataLabel: 'Dades',
  volumes: ({ count }) => (count === 1 ? '1 volum' : `${count} volums`),
  reachTitle: 'Què executa i què pot abastar',
  addressTitle: 'La teva adreça, amb HTTPS',
  addressBody: ({ service, port }) =>
    `Happier l’encamina a ${service} al port ${port}`,
  internalTitle: ({ service, port }) => `${service} al port ${port}`,
  keptTitle: ({ count }) =>
    count === 1
      ? 'Un volum, conservat entre desplegaments'
      : `${count} volums, conservats entre desplegaments`,
  keptBody: ({ count }) => (count === 1 ? 'Fes-ne còpia des del seu entorn quan s’executi' : 'Fes-ne còpia des del seu entorn quan s’executi'),
  secretsTitle: ({ count }) =>
    count === 1
      ? 'Un secret, generat i desat per a tu'
      : `${count} secrets, generats i desats per a tu`,
  secretsBody: 'Mai no es mostren aquí; obre’ls a Secrets desats',
  firstRunTitle: 'Qui l’obri primer crea l’administrador',
  firstRunBody:
    'Obre-la tan bon punt arrenqui; la seva pàgina t’ho recorda fins que ho facis',
  reviewTitle: 'Cal revisar',
  reviewDescription:
    'Happier encara no pot assignar aquests paràmetres de la plantilla. No s’instal·la res fins que estiguin tots assignats.',
  prepareTitle: ({ name }) => `Instal·la ${name}`,
  prepareDescription: 'No es crea res fins que confirmis.',
  whereTitle: 'On s’executa',
  whereDescription: ({ name }) =>
    `La màquina que executa ${name} i en conserva les dades.`,
  noMachine: 'Connecta una màquina per executar apps',
  firstRunWarningTitle: 'Crea primer el teu compte d’administrador',
  firstRunWarningBody: 'Fins que no ho facis, qui obri primer l’adreça el pot crear.',
  projectTitle: 'Projecte',
  projectDescription: 'On el trobaràs després.',
  projectNew: 'Projecte nou',
  projectNewHint: 'Comença buit, només per a aquesta aplicació',
  projectNameLabel: 'Nom del projecte',
  projectOwnerLabel: 'Propietari',
  projectOwnerYou: 'Tu',
  nameProject: 'Posa nom al projecte nou',
  projectsLoading: 'Carregant projectes…',
  deploysTitle: 'Desplegaments',
  deploysDescription:
    'S’aplica l’elecció del teu compte si no tries una màquina aquí.',
  controllerLabel: 'Desplega des de',
  controllerDefault: 'La teva màquina habitual',
  chooseMachine: 'Primer tria una màquina',
  nameEnvironment: 'Primer posa-li un nom',
  domainAddress: 'Adreça',
  domainAddressFor: ({ service }) => `Adreça per a ${service}`,
  domainDnsHint: ({ route }) => `Fes que el DNS d’aquest nom apunti a la màquina; ${route}`,
  domainPlaceholder: 'example.com',
  domainRequired: 'Aquesta aplicació necessita una adreça pública, com ara example.com.',
  domainInvalid: "Introdueix un nom d’amfitrió vàlid, com ara app.example.com.",
  chooseProject: 'Primer tria un projecte',
  projectPlaceholder: 'Tria un projecte',
  review: 'Revisa',
  back: 'Enrere',
  preparedTitle: 'A punt per instal·lar',
  preparedDescription: 'Això és tot el que passarà.',
  createOn: ({ name, machine }) => `Crear «${name}» a ${machine}`,
  nameAndAddressTitle: 'Nom i adreça',
  defaultsTitle: 'Configuració de desplegament',
  managersDeploy: 'Els gestors poden desplegar',
  inNewProject: ({ name }) => `En un projecte nou, ${name} · sense repositori`,
  inProject: ({ project }) => `A ${project}`,
  refused: ({ name }) => `No s’ha pogut preparar ${name}`,
  approvalWaiting: 'Esperant l’aprovació',
  approvalDescription: 'Quan s’aprovi, torna-la a revisar aquí.',
};

const de: StoreAppPageTranslation = {
  choices: templateChoicesTranslations.de,
  install: 'Installieren und bereitstellen',
  installNote: 'Als Nächstes wählst du die Maschine, auf der sie läuft.',
  needsReviewHint: 'Muss vor der Installation geprüft werden',
  runsLabel: 'Läuft',
  services: ({ count }) => (count === 1 ? '1 Dienst' : `${count} Dienste`),
  needsLabel: 'Braucht',
  memory: ({ size }) => `Etwa ${size}`,
  licenceLabel: 'Lizenz',
  firstRunLabel: 'Erster Start',
  firstRunValue: 'Du legst den Admin an',
  dataLabel: 'Daten',
  volumes: ({ count }) => (count === 1 ? '1 Volume' : `${count} Volumes`),
  reachTitle: 'Was sie ausführt und erreicht',
  addressTitle: 'Deine Adresse, mit HTTPS',
  addressBody: ({ service, port }) =>
    `Happier leitet sie an ${service} auf Port ${port}`,
  internalTitle: ({ service, port }) => `${service} auf Port ${port}`,
  keptTitle: ({ count }) =>
    count === 1
      ? 'Ein Volume, über Bereitstellungen erhalten'
      : `${count} Volumes, über Bereitstellungen erhalten`,
  keptBody: ({ count }) => (count === 1 ? 'Sichere es in seiner Umgebung, sobald sie läuft' : 'Sichere sie in ihrer Umgebung, sobald sie läuft'),
  secretsTitle: ({ count }) =>
    count === 1
      ? 'Ein Geheimnis, für dich erzeugt und gespeichert'
      : `${count} Geheimnisse, für dich erzeugt und gespeichert`,
  secretsBody: 'Nie hier angezeigt; öffne sie unter Gespeicherte Geheimnisse',
  firstRunTitle: 'Wer sie zuerst öffnet, legt den Admin an',
  firstRunBody:
    'Öffne sie direkt nach dem Start; ihre Seite erinnert dich, bis du es tust',
  reviewTitle: 'Prüfung nötig',
  reviewDescription:
    'Happier kann diese Einstellungen der Vorlage noch nicht zuordnen. Nichts wird installiert, bis jede zugeordnet ist.',
  prepareTitle: ({ name }) => `${name} installieren`,
  prepareDescription: 'Nichts wird angelegt, bis du bestätigst.',
  whereTitle: 'Wo sie läuft',
  whereDescription: ({ name }) =>
    `Die Maschine, die ${name} ausführt und ihre Daten behält.`,
  noMachine: 'Verbinde eine Maschine, um Apps auszuführen',
  firstRunWarningTitle: 'Leg zuerst dein Admin-Konto an',
  firstRunWarningBody: 'Bis dahin kann es anlegen, wer die Adresse zuerst öffnet.',
  projectTitle: 'Projekt',
  projectDescription: 'Wo du sie später findest.',
  projectNew: 'Neues Projekt',
  projectNewHint: 'Startet leer, nur für diese App',
  projectNameLabel: 'Projektname',
  projectOwnerLabel: 'Eigentümer',
  projectOwnerYou: 'Du',
  nameProject: 'Gib dem neuen Projekt einen Namen',
  projectsLoading: 'Projekte werden geladen…',
  deploysTitle: 'Bereitstellungen',
  deploysDescription:
    'Die Wahl deines Kontos gilt, wenn du hier keine Maschine wählst.',
  controllerLabel: 'Bereitstellung von',
  controllerDefault: 'Deine übliche Maschine',
  chooseMachine: 'Wähle zuerst eine Maschine',
  nameEnvironment: 'Gib ihr zuerst einen Namen',
  domainAddress: 'Adresse',
  domainAddressFor: ({ service }) => `Adresse für ${service}`,
  domainDnsHint: ({ route }) => `Richte den DNS dieses Namens auf die Maschine; ${route}`,
  domainPlaceholder: 'example.com',
  domainRequired: 'Diese App benötigt eine öffentliche Adresse, z. B. example.com.',
  domainInvalid: "Gib einen gültigen Hostnamen ein, etwa app.example.com.",
  chooseProject: 'Wähle zuerst ein Projekt',
  projectPlaceholder: 'Projekt wählen',
  review: 'Prüfen',
  back: 'Zurück',
  preparedTitle: 'Bereit zur Installation',
  preparedDescription: 'Das ist alles, was passieren wird.',
  createOn: ({ name, machine }) => `„${name}“ auf ${machine} anlegen`,
  nameAndAddressTitle: 'Name und Adresse',
  defaultsTitle: 'Bereitstellungseinstellungen',
  managersDeploy: 'Manager können bereitstellen',
  inNewProject: ({ name }) =>
    `In einem neuen Projekt, ${name} · ohne Repository`,
  inProject: ({ project }) => `In ${project}`,
  refused: ({ name }) => `${name} konnte nicht vorbereitet werden`,
  approvalWaiting: 'Wartet auf Freigabe',
  approvalDescription: 'Sobald sie freigegeben ist, prüfe sie hier erneut.',
};

const es: StoreAppPageTranslation = {
  choices: templateChoicesTranslations.es,
  install: 'Instalar y desplegar',
  installNote: 'Después eliges la máquina que la ejecuta.',
  needsReviewHint: 'Necesita revisión antes de instalarse',
  runsLabel: 'Ejecuta',
  services: ({ count }) => (count === 1 ? '1 servicio' : `${count} servicios`),
  needsLabel: 'Necesita',
  memory: ({ size }) => `Unos ${size}`,
  licenceLabel: 'Licencia',
  firstRunLabel: 'Primer uso',
  firstRunValue: 'Tú creas el administrador',
  dataLabel: 'Datos',
  volumes: ({ count }) => (count === 1 ? '1 volumen' : `${count} volúmenes`),
  reachTitle: 'Qué ejecuta y a qué llega',
  addressTitle: 'Tu dirección, con HTTPS',
  addressBody: ({ service, port }) =>
    `Happier la dirige a ${service} en el puerto ${port}`,
  internalTitle: ({ service, port }) => `${service} en el puerto ${port}`,
  keptTitle: ({ count }) =>
    count === 1
      ? 'Un volumen, conservado entre despliegues'
      : `${count} volúmenes, conservados entre despliegues`,
  keptBody: ({ count }) => (count === 1 ? 'Haz copia desde su entorno cuando esté en marcha' : 'Haz copia desde su entorno cuando esté en marcha'),
  secretsTitle: ({ count }) =>
    count === 1
      ? 'Un secreto, generado y guardado para ti'
      : `${count} secretos, generados y guardados para ti`,
  secretsBody: 'Nunca se muestran aquí; ábrelos en Secretos guardados',
  firstRunTitle: 'Quien la abra primero crea el administrador',
  firstRunBody:
    'Ábrela en cuanto arranque; su página te lo recuerda hasta que lo hagas',
  reviewTitle: 'Necesita revisión',
  reviewDescription:
    'Happier aún no puede asignar estos ajustes de la plantilla. No se instala nada hasta que estén todos asignados.',
  prepareTitle: ({ name }) => `Instalar ${name}`,
  prepareDescription: 'No se crea nada hasta que confirmes.',
  whereTitle: 'Dónde se ejecuta',
  whereDescription: ({ name }) =>
    `La máquina que ejecuta ${name} y guarda sus datos.`,
  noMachine: 'Conecta una máquina para ejecutar apps',
  firstRunWarningTitle: 'Crea primero tu cuenta de administrador',
  firstRunWarningBody: 'Hasta entonces, quien abra primero la dirección puede crearla.',
  projectTitle: 'Proyecto',
  projectDescription: 'Dónde la encontrarás después.',
  projectNew: 'Proyecto nuevo',
  projectNewHint: 'Empieza vacío, solo para esta aplicación',
  projectNameLabel: 'Nombre del proyecto',
  projectOwnerLabel: 'Propietario',
  projectOwnerYou: 'Tú',
  nameProject: 'Ponle nombre al proyecto nuevo',
  projectsLoading: 'Cargando proyectos…',
  deploysTitle: 'Despliegues',
  deploysDescription:
    'Se aplica la elección de tu cuenta si no eliges una máquina aquí.',
  controllerLabel: 'Despliega desde',
  controllerDefault: 'Tu máquina habitual',
  chooseMachine: 'Elige primero una máquina',
  nameEnvironment: 'Ponle primero un nombre',
  domainAddress: 'Dirección',
  domainAddressFor: ({ service }) => `Dirección para ${service}`,
  domainDnsHint: ({ route }) => `Apunta el DNS de este nombre a la máquina; ${route}`,
  domainPlaceholder: 'example.com',
  domainRequired: 'Esta aplicación necesita una dirección pública, como example.com.',
  domainInvalid: "Introduce un nombre de host válido, como app.example.com.",
  chooseProject: 'Elige primero un proyecto',
  projectPlaceholder: 'Elige un proyecto',
  review: 'Revisar',
  back: 'Atrás',
  preparedTitle: 'Lista para instalar',
  preparedDescription: 'Esto es todo lo que pasará.',
  createOn: ({ name, machine }) => `Crear «${name}» en ${machine}`,
  nameAndAddressTitle: 'Nombre y dirección',
  defaultsTitle: 'Ajustes de despliegue',
  managersDeploy: 'Los gestores pueden desplegar',
  inNewProject: ({ name }) => `En un proyecto nuevo, ${name} · sin repositorio`,
  inProject: ({ project }) => `En ${project}`,
  refused: ({ name }) => `No se pudo preparar ${name}`,
  approvalWaiting: 'Esperando aprobación',
  approvalDescription: 'Cuando se apruebe, revísala de nuevo aquí.',
};

const fr: StoreAppPageTranslation = {
  choices: templateChoicesTranslations.fr,
  install: 'Installer et déployer',
  installNote: 'Ensuite, tu choisis la machine qui l’exécute.',
  needsReviewHint: 'Doit être vérifiée avant l’installation',
  runsLabel: 'Exécute',
  services: ({ count }) => (count === 1 ? '1 service' : `${count} services`),
  needsLabel: 'Requiert',
  memory: ({ size }) => `Environ ${size}`,
  licenceLabel: 'Licence',
  firstRunLabel: 'Premier lancement',
  firstRunValue: 'Tu crées l’administrateur',
  dataLabel: 'Données',
  volumes: ({ count }) => (count === 1 ? '1 volume' : `${count} volumes`),
  reachTitle: 'Ce qu’elle exécute et peut atteindre',
  addressTitle: 'Ton adresse, en HTTPS',
  addressBody: ({ service, port }) =>
    `Happier la dirige vers ${service} sur le port ${port}`,
  internalTitle: ({ service, port }) => `${service} sur le port ${port}`,
  keptTitle: ({ count }) =>
    count === 1
      ? 'Un volume, conservé entre les déploiements'
      : `${count} volumes, conservés entre les déploiements`,
  keptBody: ({ count }) => (count === 1 ? 'Sauvegarde-le depuis son environnement une fois lancée' : 'Sauvegarde-les depuis son environnement une fois lancée'),
  secretsTitle: ({ count }) =>
    count === 1
      ? 'Un secret, généré et enregistré pour toi'
      : `${count} secrets, générés et enregistrés pour toi`,
  secretsBody: 'Jamais affichés ici ; ouvre-les dans Secrets enregistrés',
  firstRunTitle: 'La première personne qui l’ouvre crée l’administrateur',
  firstRunBody:
    'Ouvre-la dès son démarrage ; sa page te le rappelle tant que ce n’est pas fait',
  reviewTitle: 'À vérifier',
  reviewDescription:
    'Happier ne peut pas encore associer ces réglages du modèle. Rien ne s’installe tant qu’ils ne sont pas tous associés.',
  prepareTitle: ({ name }) => `Installer ${name}`,
  prepareDescription: 'Rien n’est créé tant que tu ne confirmes pas.',
  whereTitle: 'Où elle tourne',
  whereDescription: ({ name }) =>
    `La machine qui exécute ${name} et garde ses données.`,
  noMachine: 'Connecte une machine pour exécuter des apps',
  firstRunWarningTitle: 'Crée d’abord ton compte administrateur',
  firstRunWarningBody: 'En attendant, le premier à ouvrir l’adresse peut le créer.',
  projectTitle: 'Projet',
  projectDescription: 'Où tu la retrouveras.',
  projectNew: 'Nouveau projet',
  projectNewHint: 'Démarre vide, rien que pour cette application',
  projectNameLabel: 'Nom du projet',
  projectOwnerLabel: 'Propriétaire',
  projectOwnerYou: 'Toi',
  nameProject: 'Donne un nom au nouveau projet',
  projectsLoading: 'Chargement des projets…',
  deploysTitle: 'Déploiements',
  deploysDescription:
    'Le choix de ton compte s’applique si tu ne choisis pas de machine ici.',
  controllerLabel: 'Déploie depuis',
  controllerDefault: 'Ta machine habituelle',
  chooseMachine: 'Choisis d’abord une machine',
  nameEnvironment: 'Donne-lui d’abord un nom',
  domainAddress: 'Adresse',
  domainAddressFor: ({ service }) => `Adresse pour ${service}`,
  domainDnsHint: ({ route }) => `Fais pointer le DNS de ce nom vers la machine ; ${route}`,
  domainPlaceholder: 'example.com',
  domainRequired: 'Cette application a besoin d’une adresse publique, par exemple example.com.',
  domainInvalid: "Saisissez un nom d’hôte valide, par exemple app.example.com.",
  chooseProject: 'Choisis d’abord un projet',
  projectPlaceholder: 'Choisis un projet',
  review: 'Vérifier',
  back: 'Retour',
  preparedTitle: 'Prête à installer',
  preparedDescription: 'Voici tout ce qui va se passer.',
  createOn: ({ name, machine }) => `Créer « ${name} » sur ${machine}`,
  nameAndAddressTitle: 'Nom et adresse',
  defaultsTitle: 'Réglages de déploiement',
  managersDeploy: 'Les gestionnaires peuvent déployer',
  inNewProject: ({ name }) => `Dans un nouveau projet, ${name} · sans dépôt`,
  inProject: ({ project }) => `Dans ${project}`,
  refused: ({ name }) => `Impossible de préparer ${name}`,
  approvalWaiting: 'En attente d’approbation',
  approvalDescription: 'Une fois approuvée, vérifie-la à nouveau ici.',
};

const it: StoreAppPageTranslation = {
  choices: templateChoicesTranslations.it,
  install: 'Installa e distribuisci',
  installNote: 'Poi scegli la macchina che la esegue.',
  needsReviewHint: 'Va verificata prima dell’installazione',
  runsLabel: 'Esegue',
  services: ({ count }) => (count === 1 ? '1 servizio' : `${count} servizi`),
  needsLabel: 'Richiede',
  memory: ({ size }) => `Circa ${size}`,
  licenceLabel: 'Licenza',
  firstRunLabel: 'Primo avvio',
  firstRunValue: 'Crei tu l’amministratore',
  dataLabel: 'Dati',
  volumes: ({ count }) => (count === 1 ? '1 volume' : `${count} volumi`),
  reachTitle: 'Cosa esegue e cosa raggiunge',
  addressTitle: 'Il tuo indirizzo, con HTTPS',
  addressBody: ({ service, port }) =>
    `Happier lo instrada a ${service} sulla porta ${port}`,
  internalTitle: ({ service, port }) => `${service} sulla porta ${port}`,
  keptTitle: ({ count }) =>
    count === 1
      ? 'Un volume, conservato tra le distribuzioni'
      : `${count} volumi, conservati tra le distribuzioni`,
  keptBody: ({ count }) => (count === 1 ? 'Fanne il backup dal suo ambiente quando è in esecuzione' : 'Fanne il backup dal suo ambiente quando è in esecuzione'),
  secretsTitle: ({ count }) =>
    count === 1
      ? 'Un segreto, generato e salvato per te'
      : `${count} segreti, generati e salvati per te`,
  secretsBody: 'Mai mostrati qui; aprili in Segreti salvati',
  firstRunTitle: 'Chi la apre per primo crea l’amministratore',
  firstRunBody:
    'Aprila appena parte; la sua pagina te lo ricorda finché non lo fai',
  reviewTitle: 'Da verificare',
  reviewDescription:
    'Happier non può ancora mappare queste impostazioni del modello. Non si installa nulla finché non sono tutte mappate.',
  prepareTitle: ({ name }) => `Installa ${name}`,
  prepareDescription: 'Non viene creato nulla finché non confermi.',
  whereTitle: 'Dove gira',
  whereDescription: ({ name }) =>
    `La macchina che esegue ${name} e ne conserva i dati.`,
  noMachine: 'Collega una macchina per eseguire app',
  firstRunWarningTitle: 'Crea prima il tuo account amministratore',
  firstRunWarningBody: 'Fino ad allora, chi apre per primo l’indirizzo può crearlo.',
  projectTitle: 'Progetto',
  projectDescription: 'Dove la ritroverai.',
  projectNew: 'Nuovo progetto',
  projectNewHint: 'Parte vuoto, solo per questa app',
  projectNameLabel: 'Nome del progetto',
  projectOwnerLabel: 'Proprietario',
  projectOwnerYou: 'Tu',
  nameProject: 'Dai un nome al nuovo progetto',
  projectsLoading: 'Caricamento progetti…',
  deploysTitle: 'Distribuzioni',
  deploysDescription:
    'Vale la scelta del tuo account se qui non scegli una macchina.',
  controllerLabel: 'Distribuisce da',
  controllerDefault: 'La tua macchina abituale',
  chooseMachine: 'Scegli prima una macchina',
  nameEnvironment: 'Dalle prima un nome',
  domainAddress: 'Indirizzo',
  domainAddressFor: ({ service }) => `Indirizzo per ${service}`,
  domainDnsHint: ({ route }) => `Punta il DNS di questo nome alla macchina; ${route}`,
  domainPlaceholder: 'example.com',
  domainRequired: 'Questa app richiede un indirizzo pubblico, ad esempio example.com.',
  domainInvalid: "Inserisci un nome host valido, ad esempio app.example.com.",
  chooseProject: 'Scegli prima un progetto',
  projectPlaceholder: 'Scegli un progetto',
  review: 'Verifica',
  back: 'Indietro',
  preparedTitle: 'Pronta da installare',
  preparedDescription: 'Ecco tutto quello che succederà.',
  createOn: ({ name, machine }) => `Creare «${name}» su ${machine}`,
  nameAndAddressTitle: 'Nome e indirizzo',
  defaultsTitle: 'Impostazioni di distribuzione',
  managersDeploy: 'I gestori possono distribuire',
  inNewProject: ({ name }) =>
    `In un nuovo progetto, ${name} · senza repository`,
  inProject: ({ project }) => `In ${project}`,
  refused: ({ name }) => `Impossibile preparare ${name}`,
  approvalWaiting: 'In attesa di approvazione',
  approvalDescription: 'Quando viene approvata, verificala di nuovo qui.',
};

const ja: StoreAppPageTranslation = {
  choices: templateChoicesTranslations.ja,
  install: 'インストールしてデプロイ',
  installNote: '次に、実行するマシンを選びます。',
  needsReviewHint: 'インストール前に確認が必要です',
  runsLabel: '実行',
  services: ({ count }) => `${count} 個のサービス`,
  needsLabel: '必要',
  memory: ({ size }) => `約 ${size}`,
  licenceLabel: 'ライセンス',
  firstRunLabel: '初回起動',
  firstRunValue: 'あなたが管理者を作成',
  dataLabel: 'データ',
  volumes: ({ count }) => `${count} 個のボリューム`,
  reachTitle: '実行するものとアクセス先',
  addressTitle: 'あなたのアドレス（HTTPS）',
  addressBody: ({ service, port }) =>
    `Happier が ${service} のポート ${port} にルーティングします`,
  internalTitle: ({ service, port }) => `${service}（ポート ${port}）`,
  keptTitle: ({ count }) => `${count} 個のボリューム、デプロイ間で保持`,
  keptBody: ({ count }) => (count === 1 ? '実行後、その環境からバックアップできます' : '実行後、その環境からバックアップできます'),
  secretsTitle: ({ count }) => `${count} 個のシークレットを生成して保存`,
  secretsBody: 'ここには表示されません。保存済みシークレットで開けます',
  firstRunTitle: '最初に開いた人が管理者を作成します',
  firstRunBody:
    '起動したらすぐに開いてください。完了するまでページで案内します',
  reviewTitle: '確認が必要',
  reviewDescription:
    'Happier はテンプレートのこれらの設定をまだ対応付けできません。すべて対応付けられるまで何もインストールされません。',
  prepareTitle: ({ name }) => `${name} をインストール`,
  prepareDescription: '確認するまで何も作成されません。',
  whereTitle: '実行場所',
  whereDescription: ({ name }) =>
    `${name} を実行し、データを保持するマシンです。`,
  noMachine: 'アプリを実行するにはマシンを接続してください',
  firstRunWarningTitle: '先に管理者アカウントを作成してください',
  firstRunWarningBody: '作成するまでは、最初にアドレスを開いた人が作成できます。',
  projectTitle: 'プロジェクト',
  projectDescription: 'あとで見つける場所です。',
  projectNew: '新しいプロジェクト',
  projectNewHint: 'このアプリ専用の空のプロジェクト',
  projectNameLabel: 'プロジェクト名',
  projectOwnerLabel: '所有者',
  projectOwnerYou: 'あなた',
  nameProject: '新しいプロジェクトに名前を付けてください',
  projectsLoading: 'プロジェクトを読み込み中…',
  deploysTitle: 'デプロイ',
  deploysDescription:
    'ここでマシンを選ばない場合はアカウントの設定が使われます。',
  controllerLabel: 'デプロイ元',
  controllerDefault: 'いつものマシン',
  chooseMachine: '先にマシンを選んでください',
  nameEnvironment: '先に名前を付けてください',
  domainAddress: 'アドレス',
  domainAddressFor: ({ service }) => `${service} のアドレス`,
  domainDnsHint: ({ route }) => `この名前の DNS をマシンに向けてください。${route}`,
  domainPlaceholder: 'example.com',
  domainRequired: 'このアプリには example.com のような公開アドレスが必要です。',
  domainInvalid: "app.example.com のような有効なホスト名を入力してください。",
  chooseProject: '先にプロジェクトを選んでください',
  projectPlaceholder: 'プロジェクトを選択',
  review: '確認',
  back: '戻る',
  preparedTitle: 'インストールの準備ができました',
  preparedDescription: '実行される内容はこれですべてです。',
  createOn: ({ name, machine }) => `${machine} に「${name}」を作成`,
  nameAndAddressTitle: '名前とアドレス',
  defaultsTitle: 'デプロイ設定',
  managersDeploy: '管理者がデプロイできます',
  inNewProject: ({ name }) => `新しいプロジェクト ${name} · リポジトリなし`,
  inProject: ({ project }) => `${project} 内`,
  refused: ({ name }) => `${name} を準備できませんでした`,
  approvalWaiting: '承認待ち',
  approvalDescription: '承認されたら、ここで再度確認してください。',
};

const pl: StoreAppPageTranslation = {
  choices: templateChoicesTranslations.pl,
  install: 'Zainstaluj i wdróż',
  installNote: 'Następnie wybierzesz maszynę, na której działa.',
  needsReviewHint: 'Wymaga przeglądu przed instalacją',
  runsLabel: 'Uruchamia',
  services: ({ count }) => (count === 1 ? '1 usługa' : `Usługi: ${count}`),
  needsLabel: 'Wymaga',
  memory: ({ size }) => `Około ${size}`,
  licenceLabel: 'Licencja',
  firstRunLabel: 'Pierwsze uruchomienie',
  firstRunValue: 'Ty tworzysz administratora',
  dataLabel: 'Dane',
  volumes: ({ count }) => (count === 1 ? '1 wolumin' : `Woluminy: ${count}`),
  reachTitle: 'Co uruchamia i do czego sięga',
  addressTitle: 'Twój adres, z HTTPS',
  addressBody: ({ service, port }) =>
    `Happier kieruje go do ${service} na porcie ${port}`,
  internalTitle: ({ service, port }) => `${service} na porcie ${port}`,
  keptTitle: ({ count }) =>
    count === 1
      ? 'Jeden wolumin, zachowany między wdrożeniami'
      : `Woluminy (${count}), zachowane między wdrożeniami`,
  keptBody: ({ count }) => (count === 1 ? 'Zrób kopię z jej środowiska, gdy już działa' : 'Zrób kopię z jej środowiska, gdy już działa'),
  secretsTitle: ({ count }) =>
    count === 1
      ? 'Jeden sekret, wygenerowany i zapisany dla ciebie'
      : `Sekrety (${count}), wygenerowane i zapisane dla ciebie`,
  secretsBody: 'Nigdy nie są tu pokazywane; otwórz je w Zapisanych sekretach',
  firstRunTitle: 'Kto otworzy ją pierwszy, tworzy administratora',
  firstRunBody:
    'Otwórz ją zaraz po starcie; jej strona przypomina o tym, dopóki tego nie zrobisz',
  reviewTitle: 'Wymaga przeglądu',
  reviewDescription:
    'Happier nie potrafi jeszcze przypisać tych ustawień szablonu. Nic się nie zainstaluje, dopóki każde nie zostanie przypisane.',
  prepareTitle: ({ name }) => `Zainstaluj ${name}`,
  prepareDescription: 'Nic nie zostanie utworzone, dopóki nie potwierdzisz.',
  whereTitle: 'Gdzie działa',
  whereDescription: ({ name }) =>
    `Maszyna, która uruchamia ${name} i przechowuje jej dane.`,
  noMachine: 'Połącz maszynę, aby uruchamiać aplikacje',
  firstRunWarningTitle: 'Najpierw utwórz konto administratora',
  firstRunWarningBody: 'Do tego czasu może je utworzyć ten, kto pierwszy otworzy adres.',
  projectTitle: 'Projekt',
  projectDescription: 'Gdzie znajdziesz ją później.',
  projectNew: 'Nowy projekt',
  projectNewHint: 'Zaczyna pusty, tylko dla tej aplikacji',
  projectNameLabel: 'Nazwa projektu',
  projectOwnerLabel: 'Właściciel',
  projectOwnerYou: 'Ty',
  nameProject: 'Nazwij nowy projekt',
  projectsLoading: 'Wczytywanie projektów…',
  deploysTitle: 'Wdrożenia',
  deploysDescription:
    'Obowiązuje wybór twojego konta, chyba że wybierzesz tu maszynę.',
  controllerLabel: 'Wdraża z',
  controllerDefault: 'Twoja zwykła maszyna',
  chooseMachine: 'Najpierw wybierz maszynę',
  nameEnvironment: 'Najpierw nadaj jej nazwę',
  domainAddress: 'Adres',
  domainAddressFor: ({ service }) => `Adres dla ${service}`,
  domainDnsHint: ({ route }) => `Skieruj DNS tej nazwy na maszynę; ${route}`,
  domainPlaceholder: 'example.com',
  domainRequired: 'Ta aplikacja wymaga publicznego adresu, np. example.com.',
  domainInvalid: "Wpisz prawidłową nazwę hosta, na przykład app.example.com.",
  chooseProject: 'Najpierw wybierz projekt',
  projectPlaceholder: 'Wybierz projekt',
  review: 'Przejrzyj',
  back: 'Wstecz',
  preparedTitle: 'Gotowa do instalacji',
  preparedDescription: 'To wszystko, co się wydarzy.',
  createOn: ({ name, machine }) => `Utworzyć „${name}” na ${machine}`,
  nameAndAddressTitle: 'Nazwa i adres',
  defaultsTitle: 'Ustawienia wdrażania',
  managersDeploy: 'Menedżerowie mogą wdrażać',
  inNewProject: ({ name }) => `W nowym projekcie, ${name} · bez repozytorium`,
  inProject: ({ project }) => `W ${project}`,
  refused: ({ name }) => `Nie udało się przygotować ${name}`,
  approvalWaiting: 'Czeka na zatwierdzenie',
  approvalDescription: 'Po zatwierdzeniu przejrzyj ją tu ponownie.',
};

const pt: StoreAppPageTranslation = {
  choices: templateChoicesTranslations.pt,
  install: 'Instalar e implementar',
  installNote: 'A seguir, escolhe a máquina que a executa.',
  needsReviewHint: 'Precisa de revisão antes de instalar',
  runsLabel: 'Executa',
  services: ({ count }) => (count === 1 ? '1 serviço' : `${count} serviços`),
  needsLabel: 'Precisa',
  memory: ({ size }) => `Cerca de ${size}`,
  licenceLabel: 'Licença',
  firstRunLabel: 'Primeira execução',
  firstRunValue: 'Tu crias o administrador',
  dataLabel: 'Dados',
  volumes: ({ count }) => (count === 1 ? '1 volume' : `${count} volumes`),
  reachTitle: 'O que executa e o que alcança',
  addressTitle: 'O teu endereço, com HTTPS',
  addressBody: ({ service, port }) =>
    `O Happier encaminha-o para ${service} na porta ${port}`,
  internalTitle: ({ service, port }) => `${service} na porta ${port}`,
  keptTitle: ({ count }) =>
    count === 1
      ? 'Um volume, mantido entre implementações'
      : `${count} volumes, mantidos entre implementações`,
  keptBody: ({ count }) => (count === 1 ? 'Faz cópia a partir do seu ambiente quando estiver a correr' : 'Faz cópia a partir do seu ambiente quando estiver a correr'),
  secretsTitle: ({ count }) =>
    count === 1
      ? 'Um segredo, gerado e guardado para ti'
      : `${count} segredos, gerados e guardados para ti`,
  secretsBody: 'Nunca mostrados aqui; abre-os em Segredos guardados',
  firstRunTitle: 'Quem a abrir primeiro cria o administrador',
  firstRunBody: 'Abre-a assim que arrancar; a página lembra-te até o fazeres',
  reviewTitle: 'Precisa de revisão',
  reviewDescription:
    'O Happier ainda não consegue mapear estas definições do modelo. Nada é instalado até estarem todas mapeadas.',
  prepareTitle: ({ name }) => `Instalar ${name}`,
  prepareDescription: 'Nada é criado até confirmares.',
  whereTitle: 'Onde corre',
  whereDescription: ({ name }) =>
    `A máquina que executa ${name} e guarda os seus dados.`,
  noMachine: 'Liga uma máquina para executar apps',
  firstRunWarningTitle: 'Cria primeiro a tua conta de administrador',
  firstRunWarningBody: 'Até lá, quem abrir primeiro o endereço pode criá-la.',
  projectTitle: 'Projeto',
  projectDescription: 'Onde a encontrarás mais tarde.',
  projectNew: 'Novo projeto',
  projectNewHint: 'Começa vazio, só para esta aplicação',
  projectNameLabel: 'Nome do projeto',
  projectOwnerLabel: 'Proprietário',
  projectOwnerYou: 'Tu',
  nameProject: 'Dá um nome ao novo projeto',
  projectsLoading: 'A carregar projetos…',
  deploysTitle: 'Implementações',
  deploysDescription:
    'Aplica-se a escolha da tua conta, a menos que escolhas uma máquina aqui.',
  controllerLabel: 'Implementa a partir de',
  controllerDefault: 'A tua máquina habitual',
  chooseMachine: 'Escolhe primeiro uma máquina',
  nameEnvironment: 'Dá-lhe primeiro um nome',
  domainAddress: 'Endereço',
  domainAddressFor: ({ service }) => `Endereço para ${service}`,
  domainDnsHint: ({ route }) => `Aponta o DNS deste nome para a máquina; ${route}`,
  domainPlaceholder: 'example.com',
  domainRequired: 'Esta aplicação precisa de um endereço público, como example.com.',
  domainInvalid: "Introduza um nome de host válido, como app.example.com.",
  chooseProject: 'Escolhe primeiro um projeto',
  projectPlaceholder: 'Escolhe um projeto',
  review: 'Rever',
  back: 'Voltar',
  preparedTitle: 'Pronta para instalar',
  preparedDescription: 'É tudo o que vai acontecer.',
  createOn: ({ name, machine }) => `Criar «${name}» em ${machine}`,
  nameAndAddressTitle: 'Nome e endereço',
  defaultsTitle: 'Definições de implementação',
  managersDeploy: 'Os gestores podem implementar',
  inNewProject: ({ name }) => `Num novo projeto, ${name} · sem repositório`,
  inProject: ({ project }) => `Em ${project}`,
  refused: ({ name }) => `Não foi possível preparar ${name}`,
  approvalWaiting: 'À espera de aprovação',
  approvalDescription: 'Quando for aprovada, revê-a aqui de novo.',
};

const ru: StoreAppPageTranslation = {
  choices: templateChoicesTranslations.ru,
  install: 'Установить и развернуть',
  installNote: 'Дальше вы выберете машину, на которой оно работает.',
  needsReviewHint: 'Перед установкой нужна проверка',
  runsLabel: 'Запускает',
  services: ({ count }) => `Сервисов: ${count}`,
  needsLabel: 'Нужно',
  memory: ({ size }) => `Около ${size}`,
  licenceLabel: 'Лицензия',
  firstRunLabel: 'Первый запуск',
  firstRunValue: 'Вы создаёте администратора',
  dataLabel: 'Данные',
  volumes: ({ count }) => `Томов: ${count}`,
  reachTitle: 'Что запускает и к чему обращается',
  addressTitle: 'Ваш адрес, с HTTPS',
  addressBody: ({ service, port }) =>
    `Happier направляет его на ${service}, порт ${port}`,
  internalTitle: ({ service, port }) => `${service}, порт ${port}`,
  keptTitle: ({ count }) =>
    `Томов: ${count}, сохраняются между развёртываниями`,
  keptBody: ({ count }) => (count === 1 ? 'Сделайте резервную копию из его окружения после запуска' : 'Сделайте резервную копию из его окружения после запуска'),
  secretsTitle: ({ count }) =>
    `Секретов: ${count}, созданы и сохранены для вас`,
  secretsBody: 'Здесь не показываются; откройте их в «Сохранённых секретах»',
  firstRunTitle: 'Кто откроет первым, тот создаст администратора',
  firstRunBody:
    'Откройте сразу после запуска; страница будет напоминать, пока вы этого не сделаете',
  reviewTitle: 'Нужна проверка',
  reviewDescription:
    'Happier пока не может сопоставить эти настройки шаблона. Ничего не установится, пока все они не будут сопоставлены.',
  prepareTitle: ({ name }) => `Установить ${name}`,
  prepareDescription: 'Ничего не создаётся, пока вы не подтвердите.',
  whereTitle: 'Где работает',
  whereDescription: ({ name }) =>
    `Машина, которая запускает ${name} и хранит его данные.`,
  noMachine: 'Подключите машину, чтобы запускать приложения',
  firstRunWarningTitle: 'Сначала создайте учётную запись администратора',
  firstRunWarningBody: 'До этого её может создать тот, кто первым откроет адрес.',
  projectTitle: 'Проект',
  projectDescription: 'Где вы найдёте его позже.',
  projectNew: 'Новый проект',
  projectNewHint: 'Создаётся пустым, только для этого приложения',
  projectNameLabel: 'Название проекта',
  projectOwnerLabel: 'Владелец',
  projectOwnerYou: 'Вы',
  nameProject: 'Назовите новый проект',
  projectsLoading: 'Загрузка проектов…',
  deploysTitle: 'Развёртывания',
  deploysDescription:
    'Действует выбор вашего аккаунта, если здесь не выбрана машина.',
  controllerLabel: 'Развёртывает с',
  controllerDefault: 'Ваша обычная машина',
  chooseMachine: 'Сначала выберите машину',
  nameEnvironment: 'Сначала дайте имя',
  domainAddress: 'Адрес',
  domainAddressFor: ({ service }) => `Адрес для ${service}`,
  domainDnsHint: ({ route }) => `Направь DNS этого имени на машину; ${route}`,
  domainPlaceholder: 'example.com',
  domainRequired: 'Этому приложению нужен публичный адрес, например example.com.',
  domainInvalid: "Введите допустимое имя хоста, например app.example.com.",
  chooseProject: 'Сначала выберите проект',
  projectPlaceholder: 'Выберите проект',
  review: 'Проверить',
  back: 'Назад',
  preparedTitle: 'Готово к установке',
  preparedDescription: 'Вот всё, что произойдёт.',
  createOn: ({ name, machine }) => `Создать «${name}» на ${machine}`,
  nameAndAddressTitle: 'Имя и адрес',
  defaultsTitle: 'Настройки развёртывания',
  managersDeploy: 'Менеджеры могут развёртывать',
  inNewProject: ({ name }) => `В новом проекте ${name} · без репозитория`,
  inProject: ({ project }) => `В ${project}`,
  refused: ({ name }) => `Не удалось подготовить ${name}`,
  approvalWaiting: 'Ожидает одобрения',
  approvalDescription: 'После одобрения проверьте его здесь ещё раз.',
};

const zhHans: StoreAppPageTranslation = {
  choices: templateChoicesTranslations.zhHans,
  install: '安装并部署',
  installNote: '接下来选择运行它的机器。',
  needsReviewHint: '安装前需要审核',
  runsLabel: '运行',
  services: ({ count }) => `${count} 个服务`,
  needsLabel: '需要',
  memory: ({ size }) => `约 ${size}`,
  licenceLabel: '许可证',
  firstRunLabel: '首次运行',
  firstRunValue: '由你创建管理员',
  dataLabel: '数据',
  volumes: ({ count }) => `${count} 个卷`,
  reachTitle: '它运行什么、能访问什么',
  addressTitle: '你的地址，使用 HTTPS',
  addressBody: ({ service, port }) =>
    `Happier 将其路由到 ${service} 的 ${port} 端口`,
  internalTitle: ({ service, port }) => `${service}，端口 ${port}`,
  keptTitle: ({ count }) => `${count} 个卷，部署之间保留`,
  keptBody: ({ count }) => (count === 1 ? '运行后可从其环境中备份' : '运行后可从其环境中备份'),
  secretsTitle: ({ count }) => `${count} 个密钥，已为你生成并保存`,
  secretsBody: '不会在此显示；在“已保存的密钥”中打开',
  firstRunTitle: '第一个打开它的人创建管理员',
  firstRunBody: '启动后请立即打开；在你完成之前，它的页面会一直提醒',
  reviewTitle: '需要审核',
  reviewDescription:
    'Happier 还无法映射模板中的这些设置。全部映射之前不会安装任何内容。',
  prepareTitle: ({ name }) => `安装 ${name}`,
  prepareDescription: '确认之前不会创建任何内容。',
  whereTitle: '运行位置',
  whereDescription: ({ name }) => `运行 ${name} 并保存其数据的机器。`,
  noMachine: '连接一台机器以运行应用',
  firstRunWarningTitle: '请先创建你的管理员账户',
  firstRunWarningBody: '在此之前，最先打开地址的人可以创建它。',
  projectTitle: '项目',
  projectDescription: '之后在这里找到它。',
  projectNew: '新项目',
  projectNewHint: '为此应用新建一个空项目',
  projectNameLabel: '项目名称',
  projectOwnerLabel: '所有者',
  projectOwnerYou: '你',
  nameProject: '为新项目命名',
  projectsLoading: '正在加载项目…',
  deploysTitle: '部署',
  deploysDescription: '如果不在此选择机器，则使用你账户的设置。',
  controllerLabel: '部署来源',
  controllerDefault: '你常用的机器',
  chooseMachine: '请先选择机器',
  nameEnvironment: '请先命名',
  domainAddress: '地址',
  domainAddressFor: ({ service }) => `${service} 的地址`,
  domainDnsHint: ({ route }) => `将此名称的 DNS 指向机器；${route}`,
  domainPlaceholder: 'example.com',
  domainRequired: '此应用需要公共地址，例如 example.com。',
  domainInvalid: "请输入有效的主机名，例如 app.example.com。",
  chooseProject: '请先选择项目',
  projectPlaceholder: '选择项目',
  review: '审核',
  back: '返回',
  preparedTitle: '已准备好安装',
  preparedDescription: '以下是将要发生的全部内容。',
  createOn: ({ name, machine }) => `在 ${machine} 上创建“${name}”`,
  nameAndAddressTitle: '名称和地址',
  defaultsTitle: '部署设置',
  managersDeploy: '管理者可以部署',
  inNewProject: ({ name }) => `在新项目 ${name} 中 · 无仓库`,
  inProject: ({ project }) => `在 ${project} 中`,
  refused: ({ name }) => `无法准备 ${name}`,
  approvalWaiting: '等待批准',
  approvalDescription: '批准后，请在这里再次审核。',
};

const zhHant: StoreAppPageTranslation = {
  choices: templateChoicesTranslations.zhHant,
  install: '安裝並部署',
  installNote: '接下來選擇執行它的機器。',
  needsReviewHint: '安裝前需要審核',
  runsLabel: '執行',
  services: ({ count }) => `${count} 個服務`,
  needsLabel: '需要',
  memory: ({ size }) => `約 ${size}`,
  licenceLabel: '授權',
  firstRunLabel: '首次執行',
  firstRunValue: '由你建立管理員',
  dataLabel: '資料',
  volumes: ({ count }) => `${count} 個磁碟區`,
  reachTitle: '它執行什麼、能存取什麼',
  addressTitle: '你的位址，使用 HTTPS',
  addressBody: ({ service, port }) =>
    `Happier 將其路由到 ${service} 的 ${port} 埠`,
  internalTitle: ({ service, port }) => `${service}，埠 ${port}`,
  keptTitle: ({ count }) => `${count} 個磁碟區，部署之間保留`,
  keptBody: ({ count }) => (count === 1 ? '執行後可從其環境中備份' : '執行後可從其環境中備份'),
  secretsTitle: ({ count }) => `${count} 個密鑰，已為你產生並儲存`,
  secretsBody: '不會在此顯示；在「已儲存的密鑰」中開啟',
  firstRunTitle: '第一個開啟它的人建立管理員',
  firstRunBody: '啟動後請立即開啟；在你完成之前，它的頁面會持續提醒',
  reviewTitle: '需要審核',
  reviewDescription:
    'Happier 還無法對應範本中的這些設定。全部對應之前不會安裝任何內容。',
  prepareTitle: ({ name }) => `安裝 ${name}`,
  prepareDescription: '確認之前不會建立任何內容。',
  whereTitle: '執行位置',
  whereDescription: ({ name }) => `執行 ${name} 並保存其資料的機器。`,
  noMachine: '連接一台機器以執行應用程式',
  firstRunWarningTitle: '請先建立你的管理員帳戶',
  firstRunWarningBody: '在此之前，最先開啟位址的人可以建立它。',
  projectTitle: '專案',
  projectDescription: '之後在這裡找到它。',
  projectNew: '新專案',
  projectNewHint: '為此應用程式新建一個空專案',
  projectNameLabel: '專案名稱',
  projectOwnerLabel: '擁有者',
  projectOwnerYou: '你',
  nameProject: '為新專案命名',
  projectsLoading: '正在載入專案…',
  deploysTitle: '部署',
  deploysDescription: '如果不在此選擇機器，則使用你帳戶的設定。',
  controllerLabel: '部署來源',
  controllerDefault: '你常用的機器',
  chooseMachine: '請先選擇機器',
  nameEnvironment: '請先命名',
  domainAddress: '位址',
  domainAddressFor: ({ service }) => `${service} 的位址`,
  domainDnsHint: ({ route }) => `將此名稱的 DNS 指向機器；${route}`,
  domainPlaceholder: 'example.com',
  domainRequired: '此應用程式需要公開位址，例如 example.com。',
  domainInvalid: "請輸入有效的主機名稱，例如 app.example.com。",
  chooseProject: '請先選擇專案',
  projectPlaceholder: '選擇專案',
  review: '審核',
  back: '返回',
  preparedTitle: '已準備好安裝',
  preparedDescription: '以下是將要發生的全部內容。',
  createOn: ({ name, machine }) => `在 ${machine} 上建立「${name}」`,
  nameAndAddressTitle: '名稱和位址',
  defaultsTitle: '部署設定',
  managersDeploy: '管理者可以部署',
  inNewProject: ({ name }) => `在新專案 ${name} 中 · 無儲存庫`,
  inProject: ({ project }) => `在 ${project} 中`,
  refused: ({ name }) => `無法準備 ${name}`,
  approvalWaiting: '等待核准',
  approvalDescription: '核准後，請在這裡再次審核。',
};

export const storeAppPageTranslations = {
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
