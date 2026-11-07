import type { SupportedLanguage } from '../_all';

type PromotionCopy = Readonly<{
  open: string; title: string; lead: (params: { name: string; version: string }) => string;
  destination: string; image: string; imageBody: string;
  emptyTitle: string; emptyBody: string; loadFailed: string; refused: string; review: string;
}>;

export const deploymentPromotionTranslations = {
  en: {
    open: 'Promote to…', title: 'Promote deployment', lead: ({ name, version }) => `Choose where to deploy ${version} from ${name}.`,
    destination: 'Destination', image: 'Built artifact', imageBody: 'Reuse the images from this stored Compose deployment in another stored Compose environment on your servers.',
    emptyTitle: 'Choose another environment',
    emptyBody: 'Create or link a destination environment, then try again.', loadFailed: 'Couldn’t load environments', refused: 'Couldn’t promote', review: 'Review promotion',
  },
  ca: {
    open: 'Promou a…', title: 'Promou el desplegament', lead: ({ name, version }) => `Tria on desplegar ${version} de ${name}.`,
    destination: 'Destinació', image: 'Artefacte construït', imageBody: 'Reutilitza les imatges d’aquest desplegament de Compose desat en un altre entorn de Compose desat als teus servidors.',
    emptyTitle: 'Tria un altre entorn',
    emptyBody: 'Crea o enllaça un entorn de destinació i torna-ho a provar.', loadFailed: 'No s’han pogut carregar els entorns', refused: 'No s’ha pogut promoure', review: 'Revisa la promoció',
  },
  de: {
    open: 'Übernehmen nach…', title: 'Bereitstellung übernehmen', lead: ({ name, version }) => `Wähle, wo ${version} aus ${name} bereitgestellt wird.`,
    destination: 'Ziel', image: 'Erstelltes Artefakt', imageBody: 'Verwendet die Images dieser gespeicherten Compose-Bereitstellung in einer anderen gespeicherten Compose-Umgebung auf deinen Servern.',
    emptyTitle: 'Andere Umgebung wählen',
    emptyBody: 'Erstelle oder verknüpfe eine Zielumgebung und versuche es erneut.', loadFailed: 'Umgebungen konnten nicht geladen werden', refused: 'Übernahme fehlgeschlagen', review: 'Übernahme prüfen',
  },
  es: {
    open: 'Promover a…', title: 'Promover despliegue', lead: ({ name, version }) => `Elige dónde desplegar ${version} de ${name}.`,
    destination: 'Destino', image: 'Artefacto compilado', imageBody: 'Reutiliza las imágenes de este despliegue de Compose guardado en otro entorno de Compose guardado en tus servidores.',
    emptyTitle: 'Elige otro entorno',
    emptyBody: 'Crea o vincula un entorno de destino y vuelve a intentarlo.', loadFailed: 'No se pudieron cargar los entornos', refused: 'No se pudo promover', review: 'Revisar promoción',
  },
  fr: {
    open: 'Promouvoir vers…', title: 'Promouvoir le déploiement', lead: ({ name, version }) => `Choisissez où déployer ${version} depuis ${name}.`,
    destination: 'Destination', image: 'Artefact compilé', imageBody: 'Réutilise les images de ce déploiement Compose enregistré dans un autre environnement Compose enregistré sur vos serveurs.',
    emptyTitle: 'Choisir un autre environnement',
    emptyBody: 'Créez ou liez un environnement de destination, puis réessayez.', loadFailed: 'Impossible de charger les environnements', refused: 'Promotion impossible', review: 'Vérifier la promotion',
  },
  it: {
    open: 'Promuovi a…', title: 'Promuovi distribuzione', lead: ({ name, version }) => `Scegli dove distribuire ${version} da ${name}.`,
    destination: 'Destinazione', image: 'Artefatto compilato', imageBody: 'Riutilizza le immagini di questa distribuzione Compose salvata in un altro ambiente Compose salvato sui tuoi server.',
    emptyTitle: 'Scegli un altro ambiente',
    emptyBody: 'Crea o collega un ambiente di destinazione e riprova.', loadFailed: 'Impossibile caricare gli ambienti', refused: 'Impossibile promuovere', review: 'Rivedi promozione',
  },
  ja: {
    open: '昇格先…', title: 'デプロイを昇格', lead: ({ name, version }) => `${name} の ${version} をデプロイする先を選んでください。`,
    destination: '昇格先', image: 'ビルド済み', imageBody: '保存済み Compose デプロイのイメージを、自分のサーバー上の別の保存済み Compose 環境で再利用します。',
    emptyTitle: '別の環境を選んでください',
    emptyBody: '昇格先の環境を作成またはリンクしてから再試行してください。', loadFailed: '環境を読み込めませんでした', refused: '昇格できませんでした', review: '昇格を確認',
  },
  pl: {
    open: 'Promuj do…', title: 'Promuj wdrożenie', lead: ({ name, version }) => `Wybierz, gdzie wdrożyć ${version} z ${name}.`,
    destination: 'Cel', image: 'Gotowy artefakt', imageBody: 'Używa obrazów z tego zapisanego wdrożenia Compose w innym zapisanym środowisku Compose na Twoich serwerach.',
    emptyTitle: 'Wybierz inne środowisko',
    emptyBody: 'Utwórz lub połącz środowisko docelowe i spróbuj ponownie.', loadFailed: 'Nie udało się wczytać środowisk', refused: 'Nie udało się promować', review: 'Sprawdź promocję',
  },
  pt: {
    open: 'Promover para…', title: 'Promover implantação', lead: ({ name, version }) => `Escolha onde implantar ${version} de ${name}.`,
    destination: 'Destino', image: 'Artefato compilado', imageBody: 'Reutiliza as imagens desta implantação Compose salva em outro ambiente Compose salvo nos seus servidores.',
    emptyTitle: 'Escolha outro ambiente',
    emptyBody: 'Crie ou vincule um ambiente de destino e tente novamente.', loadFailed: 'Não foi possível carregar os ambientes', refused: 'Não foi possível promover', review: 'Revisar promoção',
  },
  ru: {
    open: 'Продвинуть в…', title: 'Продвинуть развёртывание', lead: ({ name, version }) => `Выберите, где развернуть ${version} из ${name}.`,
    destination: 'Назначение', image: 'Готовый артефакт', imageBody: 'Использует образы этого сохранённого развёртывания Compose в другом сохранённом окружении Compose на ваших серверах.',
    emptyTitle: 'Выберите другое окружение',
    emptyBody: 'Создайте или подключите целевое окружение и повторите попытку.', loadFailed: 'Не удалось загрузить окружения', refused: 'Не удалось продвинуть', review: 'Проверить продвижение',
  },
  'zh-Hans': {
    open: '提升至…', title: '提升部署', lead: ({ name, version }) => `选择将 ${name} 的 ${version} 部署到哪里。`,
    destination: '目标环境', image: '已构建产物', imageBody: '在你服务器上的另一个已保存 Compose 环境中，复用此已保存 Compose 部署的镜像。',
    emptyTitle: '选择其他环境',
    emptyBody: '创建或关联目标环境，然后重试。', loadFailed: '无法加载环境', refused: '无法提升部署', review: '检查提升',
  },
} satisfies Record<SupportedLanguage, PromotionCopy>;
