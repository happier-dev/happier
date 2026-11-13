import type { SupportedLanguage } from '../_all';

type PromotionCopy = Readonly<{
  open: string; title: string; lead: (params: { name: string; version: string }) => string;
  destination: string; image: string; imageBody: string;
  emptyTitle: string; emptyBody: string; loadFailed: string; refused: string; review: string;
  missingOne: (params: { destination: string; name: string }) => string;
  missingMany: (params: { destination: string; count: number }) => string;
  missingBodyOne: (params: { source: string; destination: string }) => string;
  missingBodyMany: (params: { source: string; destination: string }) => string;
  missingAdd: (params: { destination: string }) => string;
  compareFailed: (params: { destination: string }) => string;
}>;

export const deploymentPromotionTranslations = {
  en: {
    open: 'Promote to…', title: 'Promote deployment', lead: ({ name, version }) => `Choose where to deploy ${version} from ${name}.`,
    destination: 'Destination', image: 'Built artifact', imageBody: 'Reuse the images from this stored Compose deployment in another stored Compose environment on your servers.',
    emptyTitle: 'Choose another environment',
    emptyBody: 'Create or link a destination environment, then try again.', loadFailed: 'Couldn’t load environments', refused: 'Couldn’t promote', review: 'Review promotion',
    missingOne: ({ destination, name }) => `${destination} doesn’t set ${name}`, missingMany: ({ destination, count }) => `${destination} doesn’t set ${count} variables`,
    missingBodyOne: ({ source, destination }) => `${source} sets it. Add it to ${destination} first if this version reads it.`,
    missingBodyMany: ({ source, destination }) => `${source} sets them. Add them to ${destination} first if this version reads them.`,
    missingAdd: ({ destination }) => `Add to ${destination}…`, compareFailed: ({ destination }) => `Couldn’t compare variables with ${destination}`,
  },
  ca: {
    open: 'Promou a…', title: 'Promou el desplegament', lead: ({ name, version }) => `Tria on desplegar ${version} de ${name}.`,
    destination: 'Destinació', image: 'Artefacte construït', imageBody: 'Reutilitza les imatges d’aquest desplegament de Compose desat en un altre entorn de Compose desat als teus servidors.',
    emptyTitle: 'Tria un altre entorn',
    emptyBody: 'Crea o enllaça un entorn de destinació i torna-ho a provar.', loadFailed: 'No s’han pogut carregar els entorns', refused: 'No s’ha pogut promoure', review: 'Revisa la promoció',
    missingOne: ({ destination, name }) => `${destination} no defineix ${name}`, missingMany: ({ destination, count }) => `${destination} no defineix ${count} variables`,
    missingBodyOne: ({ source, destination }) => `${source} la defineix. Afegeix-la primer a ${destination} si aquesta versió la llegeix.`,
    missingBodyMany: ({ source, destination }) => `${source} les defineix. Afegeix-les primer a ${destination} si aquesta versió les llegeix.`,
    missingAdd: ({ destination }) => `Afegeix a ${destination}…`, compareFailed: ({ destination }) => `No s’han pogut comparar les variables amb ${destination}`,
  },
  de: {
    open: 'Übernehmen nach…', title: 'Bereitstellung übernehmen', lead: ({ name, version }) => `Wähle, wo ${version} aus ${name} bereitgestellt wird.`,
    destination: 'Ziel', image: 'Erstelltes Artefakt', imageBody: 'Verwendet die Images dieser gespeicherten Compose-Bereitstellung in einer anderen gespeicherten Compose-Umgebung auf deinen Servern.',
    emptyTitle: 'Andere Umgebung wählen',
    emptyBody: 'Erstelle oder verknüpfe eine Zielumgebung und versuche es erneut.', loadFailed: 'Umgebungen konnten nicht geladen werden', refused: 'Übernahme fehlgeschlagen', review: 'Übernahme prüfen',
    missingOne: ({ destination, name }) => `${destination} setzt ${name} nicht`, missingMany: ({ destination, count }) => `${destination} setzt ${count} Variablen nicht`,
    missingBodyOne: ({ source, destination }) => `${source} setzt sie. Füge sie zuerst ${destination} hinzu, wenn diese Version sie liest.`,
    missingBodyMany: ({ source, destination }) => `${source} setzt sie. Füge sie zuerst ${destination} hinzu, wenn diese Version sie liest.`,
    missingAdd: ({ destination }) => `Zu ${destination} hinzufügen…`, compareFailed: ({ destination }) => `Variablen konnten nicht mit ${destination} verglichen werden`,
  },
  es: {
    open: 'Promover a…', title: 'Promover despliegue', lead: ({ name, version }) => `Elige dónde desplegar ${version} de ${name}.`,
    destination: 'Destino', image: 'Artefacto compilado', imageBody: 'Reutiliza las imágenes de este despliegue de Compose guardado en otro entorno de Compose guardado en tus servidores.',
    emptyTitle: 'Elige otro entorno',
    emptyBody: 'Crea o vincula un entorno de destino y vuelve a intentarlo.', loadFailed: 'No se pudieron cargar los entornos', refused: 'No se pudo promover', review: 'Revisar promoción',
    missingOne: ({ destination, name }) => `${destination} no define ${name}`, missingMany: ({ destination, count }) => `${destination} no define ${count} variables`,
    missingBodyOne: ({ source, destination }) => `${source} la define. Añádela primero a ${destination} si esta versión la lee.`,
    missingBodyMany: ({ source, destination }) => `${source} las define. Añádelas primero a ${destination} si esta versión las lee.`,
    missingAdd: ({ destination }) => `Añadir a ${destination}…`, compareFailed: ({ destination }) => `No se pudieron comparar las variables con ${destination}`,
  },
  fr: {
    open: 'Promouvoir vers…', title: 'Promouvoir le déploiement', lead: ({ name, version }) => `Choisissez où déployer ${version} depuis ${name}.`,
    destination: 'Destination', image: 'Artefact compilé', imageBody: 'Réutilise les images de ce déploiement Compose enregistré dans un autre environnement Compose enregistré sur vos serveurs.',
    emptyTitle: 'Choisir un autre environnement',
    emptyBody: 'Créez ou liez un environnement de destination, puis réessayez.', loadFailed: 'Impossible de charger les environnements', refused: 'Promotion impossible', review: 'Vérifier la promotion',
    missingOne: ({ destination, name }) => `${destination} ne définit pas ${name}`, missingMany: ({ destination, count }) => `${destination} ne définit pas ${count} variables`,
    missingBodyOne: ({ source, destination }) => `${source} la définit. Ajoutez-la d’abord à ${destination} si cette version la lit.`,
    missingBodyMany: ({ source, destination }) => `${source} les définit. Ajoutez-les d’abord à ${destination} si cette version les lit.`,
    missingAdd: ({ destination }) => `Ajouter à ${destination}…`, compareFailed: ({ destination }) => `Impossible de comparer les variables avec ${destination}`,
  },
  it: {
    open: 'Promuovi a…', title: 'Promuovi distribuzione', lead: ({ name, version }) => `Scegli dove distribuire ${version} da ${name}.`,
    destination: 'Destinazione', image: 'Artefatto compilato', imageBody: 'Riutilizza le immagini di questa distribuzione Compose salvata in un altro ambiente Compose salvato sui tuoi server.',
    emptyTitle: 'Scegli un altro ambiente',
    emptyBody: 'Crea o collega un ambiente di destinazione e riprova.', loadFailed: 'Impossibile caricare gli ambienti', refused: 'Impossibile promuovere', review: 'Rivedi promozione',
    missingOne: ({ destination, name }) => `${destination} non imposta ${name}`, missingMany: ({ destination, count }) => `${destination} non imposta ${count} variabili`,
    missingBodyOne: ({ source, destination }) => `${source} la imposta. Aggiungila prima a ${destination} se questa versione la legge.`,
    missingBodyMany: ({ source, destination }) => `${source} le imposta. Aggiungile prima a ${destination} se questa versione le legge.`,
    missingAdd: ({ destination }) => `Aggiungi a ${destination}…`, compareFailed: ({ destination }) => `Impossibile confrontare le variabili con ${destination}`,
  },
  ja: {
    open: '昇格先…', title: 'デプロイを昇格', lead: ({ name, version }) => `${name} の ${version} をデプロイする先を選んでください。`,
    destination: '昇格先', image: 'ビルド済み', imageBody: '保存済み Compose デプロイのイメージを、自分のサーバー上の別の保存済み Compose 環境で再利用します。',
    emptyTitle: '別の環境を選んでください',
    emptyBody: '昇格先の環境を作成またはリンクしてから再試行してください。', loadFailed: '環境を読み込めませんでした', refused: '昇格できませんでした', review: '昇格を確認',
    missingOne: ({ destination, name }) => `${destination} には ${name} が設定されていません`, missingMany: ({ destination, count }) => `${destination} には ${count} 個の変数が設定されていません`,
    missingBodyOne: ({ source, destination }) => `${source} では設定されています。このバージョンが使う場合は、先に ${destination} に追加してください。`,
    missingBodyMany: ({ source, destination }) => `${source} では設定されています。このバージョンが使う場合は、先に ${destination} に追加してください。`,
    missingAdd: ({ destination }) => `${destination} に追加…`, compareFailed: ({ destination }) => `${destination} と変数を比較できませんでした`,
  },
  pl: {
    open: 'Promuj do…', title: 'Promuj wdrożenie', lead: ({ name, version }) => `Wybierz, gdzie wdrożyć ${version} z ${name}.`,
    destination: 'Cel', image: 'Gotowy artefakt', imageBody: 'Używa obrazów z tego zapisanego wdrożenia Compose w innym zapisanym środowisku Compose na Twoich serwerach.',
    emptyTitle: 'Wybierz inne środowisko',
    emptyBody: 'Utwórz lub połącz środowisko docelowe i spróbuj ponownie.', loadFailed: 'Nie udało się wczytać środowisk', refused: 'Nie udało się promować', review: 'Sprawdź promocję',
    missingOne: ({ destination, name }) => `${destination} nie ustawia ${name}`, missingMany: ({ destination, count }) => `${destination} nie ustawia ${count} zmiennych`,
    missingBodyOne: ({ source, destination }) => `${source} ją ustawia. Najpierw dodaj ją do ${destination}, jeśli ta wersja jej używa.`,
    missingBodyMany: ({ source, destination }) => `${source} je ustawia. Najpierw dodaj je do ${destination}, jeśli ta wersja ich używa.`,
    missingAdd: ({ destination }) => `Dodaj do ${destination}…`, compareFailed: ({ destination }) => `Nie udało się porównać zmiennych z ${destination}`,
  },
  pt: {
    open: 'Promover para…', title: 'Promover implantação', lead: ({ name, version }) => `Escolha onde implantar ${version} de ${name}.`,
    destination: 'Destino', image: 'Artefato compilado', imageBody: 'Reutiliza as imagens desta implantação Compose salva em outro ambiente Compose salvo nos seus servidores.',
    emptyTitle: 'Escolha outro ambiente',
    emptyBody: 'Crie ou vincule um ambiente de destino e tente novamente.', loadFailed: 'Não foi possível carregar os ambientes', refused: 'Não foi possível promover', review: 'Revisar promoção',
    missingOne: ({ destination, name }) => `${destination} não define ${name}`, missingMany: ({ destination, count }) => `${destination} não define ${count} variáveis`,
    missingBodyOne: ({ source, destination }) => `${source} a define. Adicione-a primeiro a ${destination} se esta versão a lê.`,
    missingBodyMany: ({ source, destination }) => `${source} as define. Adicione-as primeiro a ${destination} se esta versão as lê.`,
    missingAdd: ({ destination }) => `Adicionar a ${destination}…`, compareFailed: ({ destination }) => `Não foi possível comparar as variáveis com ${destination}`,
  },
  ru: {
    open: 'Продвинуть в…', title: 'Продвинуть развёртывание', lead: ({ name, version }) => `Выберите, где развернуть ${version} из ${name}.`,
    destination: 'Назначение', image: 'Готовый артефакт', imageBody: 'Использует образы этого сохранённого развёртывания Compose в другом сохранённом окружении Compose на ваших серверах.',
    emptyTitle: 'Выберите другое окружение',
    emptyBody: 'Создайте или подключите целевое окружение и повторите попытку.', loadFailed: 'Не удалось загрузить окружения', refused: 'Не удалось продвинуть', review: 'Проверить продвижение',
    missingOne: ({ destination, name }) => `В ${destination} не задана ${name}`, missingMany: ({ destination, count }) => `В ${destination} не заданы переменные: ${count}`,
    missingBodyOne: ({ source, destination }) => `В ${source} она задана. Сначала добавьте её в ${destination}, если эта версия её читает.`,
    missingBodyMany: ({ source, destination }) => `В ${source} они заданы. Сначала добавьте их в ${destination}, если эта версия их читает.`,
    missingAdd: ({ destination }) => `Добавить в ${destination}…`, compareFailed: ({ destination }) => `Не удалось сравнить переменные с ${destination}`,
  },
  'zh-Hans': {
    open: '提升至…', title: '提升部署', lead: ({ name, version }) => `选择将 ${name} 的 ${version} 部署到哪里。`,
    destination: '目标环境', image: '已构建产物', imageBody: '在你服务器上的另一个已保存 Compose 环境中，复用此已保存 Compose 部署的镜像。',
    emptyTitle: '选择其他环境',
    emptyBody: '创建或关联目标环境，然后重试。', loadFailed: '无法加载环境', refused: '无法提升部署', review: '检查提升',
    missingOne: ({ destination, name }) => `${destination} 没有设置 ${name}`, missingMany: ({ destination, count }) => `${destination} 有 ${count} 个变量未设置`,
    missingBodyOne: ({ source, destination }) => `${source} 设置了它。如果此版本会读取它，请先添加到 ${destination}。`,
    missingBodyMany: ({ source, destination }) => `${source} 设置了它们。如果此版本会读取它们，请先添加到 ${destination}。`,
    missingAdd: ({ destination }) => `添加到 ${destination}…`, compareFailed: ({ destination }) => `无法与 ${destination} 比较变量`,
  },
  'zh-Hant': {
    open: '提升至…', title: '提升部署', lead: ({ name, version }) => `選擇將 ${name} 的 ${version} 部署到哪裡。`,
    destination: '目標環境', image: '已建置成品', imageBody: '在你伺服器上的另一個已儲存 Compose 環境中，重複使用此已儲存 Compose 部署的映像檔。',
    emptyTitle: '選擇其他環境',
    emptyBody: '建立或連結目標環境，然後重試。', loadFailed: '無法載入環境', refused: '無法提升部署', review: '檢查提升',
    missingOne: ({ destination, name }) => `${destination} 沒有設定 ${name}`, missingMany: ({ destination, count }) => `${destination} 有 ${count} 個變數未設定`,
    missingBodyOne: ({ source, destination }) => `${source} 設定了它。如果此版本會讀取它，請先新增到 ${destination}。`,
    missingBodyMany: ({ source, destination }) => `${source} 設定了它們。如果此版本會讀取它們，請先新增到 ${destination}。`,
    missingAdd: ({ destination }) => `新增到 ${destination}…`, compareFailed: ({ destination }) => `無法與 ${destination} 比較變數`,
  },
} satisfies Record<SupportedLanguage, PromotionCopy>;
